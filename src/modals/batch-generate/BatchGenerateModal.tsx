'use client';

import {
  Badge,
  Box,
  Button,
  Divider,
  Group,
  Loader,
  Paper,
  Progress,
  Stack,
  Text,
  TextInput,
  Title,
} from '@mantine/core';
import type { ContextModalProps } from '@mantine/modals';
import { notifications } from '@mantine/notifications';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { GenerationTaskItemSummary } from '@/src/app/api/types/generation-task';
import { requestReviewedDocxDownload } from '@/src/lib/generation/download-reviewed-docx';
import { parsePdf, renderPdfPagesForVision } from '@/src/lib/pdf/client-pdf';
import {
  useGenerationTask,
  useProcessGenerationTaskItem,
} from '@/src/querys/use-generation-task-runtime';
import { useCreateGenerationTask } from '@/src/querys/use-generation-tasks';

interface BatchGenerateModalInnerProps {
  templateId: string;
  templateName: string;
}

interface UploadRow {
  id: string;
  file: File | null;
  parsedPdf: Awaited<ReturnType<typeof parsePdf>> | null;
  isParsing: boolean;
  parseError: string | null;
  pageSelectionMode: 'custom';
  pageRangeInput: string;
  forceOcr: boolean;
}

declare global {
  interface Window {
    clipcapOcrImages?: Array<{
      fileName: string;
      originalPageNumber: number;
      uploadedPageNumber: number;
      previewUrl: string;
      imageDataUrl: string;
    }>;
    clipcapOcrTextPages?: Array<{
      fileName: string;
      uploadedPageNumber: number;
      text: string;
    }>;
    clipcapSlotFillInputs?: Array<{
      fileName: string;
      label: string;
      data: {
        document_name: string;
        page_numbers: number[];
        slot_definitions: Array<{
          slot_key: string;
          slot_name: string;
          slot_meaning: string;
        }>;
        content: string;
      };
    }>;
  }
}

function createUploadRow(): UploadRow {
  return {
    id: crypto.randomUUID(),
    file: null,
    parsedPdf: null,
    isParsing: false,
    parseError: null,
    pageSelectionMode: 'custom',
    pageRangeInput: '',
    forceOcr: false,
  };
}

function buildFullPageNumbers(totalPages: number) {
  return Array.from({ length: totalPages }, (_, index) => index + 1);
}

function formatCompactPageRanges(pageNumbers: number[]) {
  if (pageNumbers.length === 0) {
    return '';
  }

  const sorted = Array.from(new Set(pageNumbers)).sort((left, right) => left - right);
  const ranges: string[] = [];
  let rangeStart = sorted[0]!;
  let previous = sorted[0]!;

  for (let index = 1; index < sorted.length; index += 1) {
    const current = sorted[index]!;

    if (current === previous + 1) {
      previous = current;
      continue;
    }

    ranges.push(rangeStart === previous ? `${rangeStart}` : `${rangeStart}-${previous}`);
    rangeStart = current;
    previous = current;
  }

  ranges.push(rangeStart === previous ? `${rangeStart}` : `${rangeStart}-${previous}`);
  return ranges.join('、');
}

function dataUrlToObjectUrl(dataUrl: string) {
  const [header, base64Payload] = dataUrl.split(',', 2);

  if (!header || !base64Payload) {
    throw new Error('OCR 图片数据无效，无法生成预览链接。');
  }

  const mimeTypeMatch = header.match(/^data:(.*?);base64$/);
  const mimeType = mimeTypeMatch?.[1] || 'image/png';
  const binary = atob(base64Payload);
  const bytes = new Uint8Array(binary.length);

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  return URL.createObjectURL(new Blob([bytes], { type: mimeType }));
}

function parseSelectedPageNumbers(input: string, totalPages: number) {
  const normalized = input.replace(/[，；;\s]+/g, ',').trim();

  if (!normalized) {
    return { pageNumbers: [] as number[], error: '请输入页码范围' };
  }

  const values = new Set<number>();
  const parts = normalized.split(',').map((part) => part.trim()).filter(Boolean);

  for (const part of parts) {
    const rangeMatch = part.match(/^(\d+)-(\d+)$/);

    if (rangeMatch) {
      const start = Number(rangeMatch[1]);
      const end = Number(rangeMatch[2]);

      if (!Number.isInteger(start) || !Number.isInteger(end) || start <= 0 || end <= 0) {
        return { pageNumbers: [] as number[], error: `页码范围 "${part}" 无效` };
      }

      if (start > end) {
        return { pageNumbers: [] as number[], error: `页码范围 "${part}" 起始页不能大于结束页` };
      }

      if (end > totalPages) {
        return {
          pageNumbers: [] as number[],
          error: `页码范围 "${part}" 超出总页数 ${totalPages} 页`,
        };
      }

      for (let pageNumber = start; pageNumber <= end; pageNumber += 1) {
        values.add(pageNumber);
      }

      continue;
    }

    const pageNumber = Number(part);

    if (!Number.isInteger(pageNumber) || pageNumber <= 0) {
      return { pageNumbers: [] as number[], error: `页码 "${part}" 无效` };
    }

    if (pageNumber > totalPages) {
      return {
        pageNumbers: [] as number[],
        error: `页码 "${part}" 超出总页数 ${totalPages} 页`,
      };
    }

    values.add(pageNumber);
  }

  const pageNumbers = Array.from(values).sort((left, right) => left - right);

  if (pageNumbers.length === 0) {
    return { pageNumbers, error: '请选择至少 1 页' };
  }

  return { pageNumbers, error: null };
}

function getStatusColor(status: string) {
  switch (status) {
    case 'uploaded':
      return 'blue';
    case 'running':
      return 'orange';
    case 'review_pending':
      return 'teal';
    case 'reviewed':
      return 'green';
    case 'failed':
      return 'red';
    default:
      return 'gray';
  }
}

function getStatusLabel(status: string) {
  switch (status) {
    case 'pending':
      return '等待中';
    case 'uploaded':
      return '已上传';
    case 'running':
      return '识别中';
    case 'review_pending':
      return '待核查';
    case 'reviewed':
      return '核查完毕';
    case 'failed':
      return '处理失败';
    default:
      return status;
  }
}

function formatElapsedSeconds(item: GenerationTaskItemSummary, now: number, startedAt: number | null) {
  if (['uploaded', 'running', 'pending'].includes(item.status) && startedAt) {
    return Math.max(item.elapsed_seconds, Math.floor((now - startedAt) / 1000));
  }

  return item.elapsed_seconds;
}

function getPendingSlotCount(item: GenerationTaskItemSummary) {
  return Math.max(0, item.slot_total_count - item.slot_completed_count);
}

export function BatchGenerateModal({
  context,
  id,
  innerProps,
}: ContextModalProps<BatchGenerateModalInnerProps>) {
  const queryClient = useQueryClient();
  const [rows, setRows] = useState<UploadRow[]>([createUploadRow()]);
  const [taskId, setTaskId] = useState<string | null>(null);
  const [tick, setTick] = useState(Date.now());
  const [isPreparingFiles, setIsPreparingFiles] = useState(false);
  const createGenerationTaskMutation = useCreateGenerationTask();
  const processGenerationTaskItemMutation = useProcessGenerationTaskItem();
  const taskQuery = useGenerationTask(taskId);
  const launchedItemIdsRef = useRef<Set<string>>(new Set());
  const itemStartedAtRef = useRef<Map<string, number>>(new Map());
  const itemTraceRef = useRef<Map<string, string>>(new Map());
  const refreshTaskLists = async () => {
    await Promise.all([
      taskId
        ? queryClient.invalidateQueries({ queryKey: ['generation-task', taskId] })
        : Promise.resolve(),
      queryClient.invalidateQueries({ queryKey: ['generation-template-tasks'] }),
      queryClient.invalidateQueries({ queryKey: ['saved-templates'] }),
    ]);
  };

  const rowsWithFiles = rows.filter((row): row is UploadRow & { file: File } => Boolean(row.file));
  const hasParsingRows = rowsWithFiles.some((row) => row.isParsing);
  const hasRowParseError = rowsWithFiles.some((row) => Boolean(row.parseError));
  const hasUnparsedRows = rowsWithFiles.some((row) => !row.parsedPdf);
  const selectedFiles = rowsWithFiles.map((row) => row.file);
  const rowSelectionStates = useMemo(
    () =>
      rows.map((row) => {
        const totalPages = row.parsedPdf?.pages.length ?? 0;
        const allPageNumbers = totalPages > 0 ? buildFullPageNumbers(totalPages) : [];
        const customSelection =
          totalPages > 0
            ? parseSelectedPageNumbers(row.pageRangeInput, totalPages)
            : { pageNumbers: [] as number[], error: null as string | null };
        const selectedPageNumbers = customSelection.pageNumbers;
        const selectionError = customSelection.error;

        return {
          rowId: row.id,
          totalPages,
          selectedPageNumbers,
          selectionError,
          selectedPageRangeLabel: formatCompactPageRanges(selectedPageNumbers),
        };
      }),
    [rows],
  );
  const hasInvalidSelection = rowSelectionStates.some(
    (state) => state.totalPages > 0 && Boolean(state.selectionError),
  );

  const canSubmit =
    selectedFiles.length > 0 &&
    !createGenerationTaskMutation.isPending &&
    !isPreparingFiles &&
    !taskId &&
    !hasParsingRows &&
    !hasRowParseError &&
    !hasUnparsedRows &&
    !hasInvalidSelection;
  const isSubmittingTask = !taskId && (createGenerationTaskMutation.isPending || isPreparingFiles);

  const taskItems = taskQuery.data?.items ?? [];
  const hasRunningItems = taskItems.some((item) =>
    ['uploaded', 'running', 'pending'].includes(item.status),
  );
  const succeededCount = taskItems.filter((item) =>
    ['review_pending', 'reviewed'].includes(item.status),
  ).length;
  const failedCount = taskItems.filter((item) => item.status === 'failed').length;
  const progressValue =
    taskItems.length > 0 ? ((succeededCount + failedCount) / taskItems.length) * 100 : 0;
  const canCloseTaskModal =
    !isPreparingFiles && (!taskId || (!taskQuery.isLoading && !hasRunningItems));
  const closeModalWithRefresh = () => {
    if (!canCloseTaskModal) {
      return;
    }

    context.closeModal(id);
    void refreshTaskLists();
  };

  useEffect(() => {
    if (!hasRunningItems) {
      return undefined;
    }

    const intervalId = window.setInterval(() => {
      setTick(Date.now());
    }, 1000);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [hasRunningItems]);

  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) {
        return;
      }

      if (
        !event.data ||
        typeof event.data !== 'object' ||
        !('type' in event.data) ||
        event.data.type !== 'generation-task-reviewed'
      ) {
        return;
      }

      void refreshTaskLists();
    };

    window.addEventListener('message', handleMessage);

    return () => {
      window.removeEventListener('message', handleMessage);
    };
  }, [queryClient, taskId]);

  useEffect(() => {
    if (!taskId || !taskQuery.data) {
      return;
    }

    taskQuery.data.items.forEach((item) => {
      if (!['uploaded', 'pending'].includes(item.status)) {
        return;
      }

      if (launchedItemIdsRef.current.has(item.id)) {
        return;
      }

      launchedItemIdsRef.current.add(item.id);
      itemStartedAtRef.current.set(item.id, Date.now());

      void processGenerationTaskItemMutation
        .mutateAsync(item.id)
        .then(() => {
          void refreshTaskLists();
        })
        .catch((error) => {
          notifications.show({
            color: 'red',
            title: '批量生成失败',
            message:
              error instanceof Error
                ? `${item.source_pdf_name}：${error.message}`
                : `${item.source_pdf_name} 处理失败，请稍后重试。`,
          });

          void refreshTaskLists();
        });
    });
  }, [processGenerationTaskItemMutation, queryClient, taskId, taskQuery.data]);

  useEffect(() => {
    if (!taskQuery.data) {
      return;
    }

    const nextKnownIds = new Set<string>();

    taskQuery.data.items.forEach((item) => {
      nextKnownIds.add(item.id);

      const nextTrace = item.processing_trace ?? '';
      const previousTrace = itemTraceRef.current.get(item.id) ?? '';

      if (!nextTrace || nextTrace === previousTrace) {
        if (!itemTraceRef.current.has(item.id)) {
          itemTraceRef.current.set(item.id, nextTrace);
        }
        return;
      }

      const previousLines = previousTrace ? previousTrace.split(/\r?\n/) : [];
      const nextLines = nextTrace.split(/\r?\n/);
      const newLines = nextLines.slice(previousLines.length).filter((line) => line.trim().length > 0);

      newLines.forEach((line) => {
        const ocrPageDataMatch = line.match(/^\[PDF Fill\]\[OCR\]\[PageData (\d+)\] (.+)$/);
        const slotFillInputMatch = line.match(
          /^(?:\[PDF Fill\])?\[TextInputData\]\[(.+)\] (.+)$/,
        );

        if (ocrPageDataMatch) {
          const uploadedPageNumber = Number(ocrPageDataMatch[1]);
          const payload = JSON.parse(ocrPageDataMatch[2] ?? '{}') as { text?: string };
          const decodedText = payload.text ?? '';
          const currentEntries = window.clipcapOcrTextPages ?? [];
          const nextEntries = currentEntries.filter(
            (entry) =>
              !(
                entry.fileName === item.source_pdf_name &&
                entry.uploadedPageNumber === uploadedPageNumber
              ),
          );

          nextEntries.push({
            fileName: item.source_pdf_name,
            uploadedPageNumber,
            text: decodedText,
          });

          window.clipcapOcrTextPages = nextEntries.sort((left, right) => {
            if (left.fileName === right.fileName) {
              return left.uploadedPageNumber - right.uploadedPageNumber;
            }

            return left.fileName.localeCompare(right.fileName);
          });

          console.info(
            `[Batch Generate][${item.source_pdf_name}] OCR full text stored in window.clipcapOcrTextPages for uploaded page ${uploadedPageNumber}.`,
          );
          return;
        }

        if (slotFillInputMatch) {
          const label = slotFillInputMatch[1] ?? 'Full';
          const parsedData = JSON.parse(slotFillInputMatch[2] ?? '{}') as {
            document_name: string;
            page_numbers: number[];
            slot_definitions: Array<{
              slot_key: string;
              slot_name: string;
              slot_meaning: string;
            }>;
            content: string;
          };
          const currentEntries = window.clipcapSlotFillInputs ?? [];
          const nextEntries = currentEntries.filter(
            (entry) => !(entry.fileName === item.source_pdf_name && entry.label === label),
          );

          nextEntries.push({
            fileName: item.source_pdf_name,
            label,
            data: parsedData,
          });

          window.clipcapSlotFillInputs = nextEntries.sort((left, right) => {
            if (left.fileName === right.fileName) {
              return left.label.localeCompare(right.label);
            }

            return left.fileName.localeCompare(right.fileName);
          });

          console.info(
            `[Batch Generate][${item.source_pdf_name}] Slot fill input stored in window.clipcapSlotFillInputs (${label}).`,
          );
          return;
        }

        console.info(`[Batch Generate][${item.source_pdf_name}] ${line}`);
      });

      itemTraceRef.current.set(item.id, nextTrace);
    });

    Array.from(itemTraceRef.current.keys()).forEach((itemId) => {
      if (!nextKnownIds.has(itemId)) {
        itemTraceRef.current.delete(itemId);
      }
    });
  }, [taskQuery.data]);

  const updateRow = (rowId: string, patch: Partial<UploadRow>) => {
    setRows((currentRows) =>
      currentRows.map((row) => (row.id === rowId ? { ...row, ...patch } : row)),
    );
  };

  const logSubmissionStage = (stage: { title: string; description: string }) => {
    console.info(`[Batch Generate][Stage] ${stage.title}：${stage.description}`);
  };

  const handleSelectPdfFile = async (rowId: string, file: File | null) => {
    updateRow(rowId, {
      file,
      parsedPdf: null,
      isParsing: Boolean(file),
      parseError: null,
      pageSelectionMode: 'custom',
      pageRangeInput: '',
      forceOcr: false,
    });

    if (!file) {
      updateRow(rowId, {
        isParsing: false,
      });
      return;
    }

    try {
      const parsedPdf = await parsePdf(file);

      updateRow(rowId, {
        parsedPdf,
        isParsing: false,
        parseError: null,
      });
    } catch (error) {
      updateRow(rowId, {
        parsedPdf: null,
        isParsing: false,
        parseError: error instanceof Error ? error.message : 'PDF 解析失败，请重新选择文件。',
      });
    }
  };

  const handleCreateTask = async () => {
    if (!canSubmit) {
      return;
    }

    setIsPreparingFiles(true);
    logSubmissionStage({
      title: '正在准备文件',
      description: '正在检查页码范围并准备批量任务输入。',
    });

    try {
      const preparedFiles = await Promise.all(
        rowsWithFiles.map(async (row, rowIndex) => {
          const file = row.file;
          const parsedPdf = row.parsedPdf;
          const rowSelectionState = rowSelectionStates.find((state) => state.rowId === row.id);

          if (!parsedPdf || !rowSelectionState) {
            throw new Error('当前 PDF 尚未解析完成，请稍候再试。');
          }

          const selectedOriginalPageNumbers = rowSelectionState.selectedPageNumbers;
          const uploadedPageNumberMapping = selectedOriginalPageNumbers.map(
            (originalPageNumber, index) => ({
              uploaded_page_number: index + 1,
              original_page_number: originalPageNumber,
            }),
          );
          logSubmissionStage({
            title: '正在生成 OCR 图片',
            description:
              `${file.name}：正在生成 OCR 图片（文件 ${rowIndex + 1}/${rowsWithFiles.length}，共 ${selectedOriginalPageNumbers.length} 页）。`,
          });
          const ocrVisionPages = await renderPdfPagesForVision(file, selectedOriginalPageNumbers);
          logSubmissionStage({
            title: 'OCR 图片生成完成',
            description:
              `${file.name}：已生成 ${ocrVisionPages.length} 张 OCR 图片，准备上传到存储。`,
          });

          const currentImages = window.clipcapOcrImages ?? [];
          const nextImages = currentImages.filter((entry) => entry.fileName !== file.name);

          ocrVisionPages.forEach((visionPage, index) => {
            const uploadedPageNumber = uploadedPageNumberMapping[index]?.uploaded_page_number ?? index + 1;
            const originalPageNumber =
              uploadedPageNumberMapping[index]?.original_page_number ?? visionPage.pageNumber;
            const previewUrl = dataUrlToObjectUrl(visionPage.imageDataUrl);

            nextImages.push({
              fileName: file.name,
              originalPageNumber,
              uploadedPageNumber,
              previewUrl,
              imageDataUrl: visionPage.imageDataUrl,
            });
          });

          window.clipcapOcrImages = nextImages.sort((left, right) => {
            if (left.fileName === right.fileName) {
              return left.uploadedPageNumber - right.uploadedPageNumber;
            }

            return left.fileName.localeCompare(right.fileName);
          });

          console.info(
            `[Batch Generate][${file.name}] OCR images prepared: ${ocrVisionPages.length} page(s). Use window.clipcapOcrImages in the browser console, or run window.open(window.clipcapOcrImages[0].previewUrl).`,
          );
          ocrVisionPages.forEach((visionPage, index) => {
            const uploadedPageNumber = uploadedPageNumberMapping[index]?.uploaded_page_number ?? index + 1;
            const originalPageNumber =
              uploadedPageNumberMapping[index]?.original_page_number ?? visionPage.pageNumber;
            const previewUrl =
              window.clipcapOcrImages?.find(
                (entry) =>
                  entry.fileName === file.name &&
                  entry.uploadedPageNumber === uploadedPageNumber,
              )?.previewUrl ?? '';

            console.info(
              `[Batch Generate][${file.name}][OCR Image] uploaded page ${uploadedPageNumber}, original PDF page ${originalPageNumber}: ${previewUrl}`,
            );
          });

          return {
            file,
            ocrVisionPages,
            selectedOriginalPageNumbers,
            uploadedPageNumberMapping,
            originalTotalPages: parsedPdf.pages.length,
            forceOcr: true,
            selectedPageRangeLabel:
              rowSelectionState.selectedPageRangeLabel || '',
          };
        }),
      );

      const result = await createGenerationTaskMutation.mutateAsync({
        templateId: innerProps.templateId,
        templateName: innerProps.templateName,
        files: preparedFiles,
        onStageChange: logSubmissionStage,
      });

      setTaskId(result.task.id);
      void Promise.all([
        queryClient.invalidateQueries({ queryKey: ['generation-template-tasks'] }),
        queryClient.invalidateQueries({ queryKey: ['saved-templates'] }),
      ]);
      notifications.show({
        color: 'teal',
        title: '批量生成已开始',
        message: `已创建 1 个任务，包含 ${result.items.length} 个 PDF 子任务。`,
      });
    } catch (error) {
      notifications.show({
        color: 'red',
        title: '创建任务失败',
        message:
          error instanceof Error ? error.message : '批量生成任务创建失败，请稍后重试。',
      });
    } finally {
      setIsPreparingFiles(false);
    }
  };

  const modalDescription = useMemo(() => {
    if (!taskId) {
      return '每条记录上传一个 PDF。创建任务前会先在本地解析 PDF，扫描件会自动挑选需要送入视觉模型的页。';
    }

    if (taskQuery.isLoading) {
      return '任务已创建，正在同步最新状态。';
    }

    return '任务已经开始执行。识别完成后，每个文件都会出现“去核查”入口；核查完毕后会显示下载结果按钮。';
  }, [taskId, taskQuery.isLoading]);

  return (
    <Box
      style={{
        position: 'relative',
        borderRadius: 24,
        overflow: 'hidden',
        isolation: 'isolate',
        padding: 24,
      }}
    >
      {isSubmittingTask ? (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            zIndex: 20,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 24,
            background: 'rgba(18, 18, 18, 0.78)',
            backdropFilter: 'blur(8px)',
            WebkitBackdropFilter: 'blur(8px)',
          }}
        >
          <Paper
            p="xl"
            radius="xl"
            withBorder
            style={{
              width: 'min(420px, 100%)',
              boxShadow: '0 18px 60px rgba(0, 0, 0, 0.32)',
              background: 'rgba(38, 38, 38, 0.92)',
            }}
          >
            <Stack align="center" gap="sm">
              <Loader color="teal" />
              <Title order={4}>正在上传文件</Title>
              <Text c="dimmed" size="sm" ta="center">
                系统正在上传并解析 PDF，随后会创建批量任务。
                这个过程可能需要一点时间，请稍候。
              </Text>
            </Stack>
          </Paper>
        </div>
      ) : null}

      <Stack gap="lg">
      <Stack gap="xs">
        <Title order={3}>批量生成任务</Title>
        <Text c="dimmed" size="sm">
          当前模板：{innerProps.templateName}。{modalDescription}
        </Text>
      </Stack>

      {!taskId ? (
        <>
          <Stack gap="md">
            {rows.map((row, index) => (
              <Paper key={row.id} p="md" radius="xl" withBorder>
                <Stack gap="sm">
                  <Group justify="space-between" align="center">
                    <Text fw={700}>#{index + 1}</Text>
                    {rows.length > 1 ? (
                      <Button
                        color="red"
                        radius="xl"
                        size="compact-sm"
                        variant="subtle"
                        onClick={() => {
                          setRows((currentRows) =>
                            currentRows.filter((currentRow) => currentRow.id !== row.id),
                          );
                        }}
                      >
                        删除
                      </Button>
                    ) : null}
                  </Group>

                  <input
                    accept="application/pdf,.pdf"
                    id={`generation-pdf-${row.id}`}
                    style={{ display: 'none' }}
                    type="file"
                    onChange={(event) => {
                      void handleSelectPdfFile(row.id, event.currentTarget.files?.[0] ?? null);
                      event.currentTarget.value = '';
                    }}
                  />

                  <Group justify="space-between" align="center">
                    <Text c={row.file ? undefined : 'dimmed'} size="sm">
                      {row.file ? row.file.name : '还未上传 PDF'}
                    </Text>
                    <Button
                      component="label"
                      htmlFor={`generation-pdf-${row.id}`}
                      radius="xl"
                      variant={row.file ? 'default' : 'light'}
                    >
                      {row.file ? '重新选择 PDF' : '上传 PDF'}
                    </Button>
                  </Group>
                  {row.file && row.parsedPdf ? (
                    <Paper
                      p="sm"
                      radius="lg"
                      style={{
                        background: 'rgba(255,255,255,0.03)',
                        border: '1px solid rgba(255,255,255,0.06)',
                      }}
                    >
                      <Stack gap="sm">
                        <Text fw={600} size="sm">
                          回填页范围
                        </Text>

                        <Text c="dimmed" size="xs">
                          总页数：{row.parsedPdf.pages.length} 页
                        </Text>

                        <TextInput
                          description="支持 1-5、1,3,5、1-5,9,12-16"
                          error={
                            rowSelectionStates.find((state) => state.rowId === row.id)
                              ?.selectionError ?? undefined
                          }
                          label="页码范围"
                          placeholder="例如：1-5,9,12-16"
                          radius="lg"
                          size="sm"
                          value={row.pageRangeInput}
                          onChange={(event) => {
                            updateRow(row.id, {
                              pageRangeInput: event.currentTarget.value,
                            });
                          }}
                        />

                        <Text c="yellow" fw={600} size="xs">
                          使用全部页面处理时间较长
                        </Text>

                        {(() => {
                          const selectionState = rowSelectionStates.find(
                            (state) => state.rowId === row.id,
                          );

                          if (!selectionState || selectionState.selectedPageNumbers.length === 0) {
                            return null;
                          }

                          return (
                            <Stack gap={6}>
                              <Text c="dimmed" size="xs">
                                将上传 {selectionState.selectedPageNumbers.length} 页，对应原 PDF 第{' '}
                                {selectionState.selectedPageRangeLabel} 页
                              </Text>
                              <Box
                                style={{
                                  display: 'grid',
                                  gridTemplateColumns: 'repeat(auto-fill, minmax(40px, 1fr))',
                                  gap: 8,
                                }}
                              >
                                {buildFullPageNumbers(row.parsedPdf.pages.length).map((pageNumber) => {
                                  const isSelected = selectionState.selectedPageNumbers.includes(pageNumber);

                                  return (
                                    <Box
                                      key={`${row.id}-page-${pageNumber}`}
                                      style={{
                                        borderRadius: 10,
                                        padding: '6px 0',
                                        textAlign: 'center',
                                        fontSize: 12,
                                        fontWeight: 600,
                                        border: `1px solid ${
                                          isSelected
                                            ? 'rgba(32, 201, 151, 0.52)'
                                            : 'rgba(255,255,255,0.10)'
                                        }`,
                                        background: isSelected
                                          ? 'rgba(32, 201, 151, 0.14)'
                                          : 'rgba(255,255,255,0.03)',
                                        color: isSelected ? '#d8fff1' : 'var(--mantine-color-dimmed)',
                                      }}
                                    >
                                      {pageNumber}
                                    </Box>
                                  );
                                })}
                              </Box>
                              <Text c="dimmed" size="xs">
                                仅会基于所选页面进行槽位回填，未选择页面中的证据不会参与抽取。
                              </Text>
                            </Stack>
                          );
                        })()}
                      </Stack>
                    </Paper>
                  ) : null}
                </Stack>
              </Paper>
            ))}
          </Stack>

          <Group justify="space-between">
            <Button
              radius="xl"
              variant="subtle"
              onClick={() => {
                setRows((currentRows) => [...currentRows, createUploadRow()]);
              }}
            >
              添加记录
            </Button>
            <Group>
              <Button color="gray" radius="xl" variant="subtle" onClick={closeModalWithRefresh}>
                取消
              </Button>
              <Button
                disabled={!canSubmit}
                loading={createGenerationTaskMutation.isPending || isPreparingFiles}
                radius="xl"
                onClick={handleCreateTask}
              >
                {isPreparingFiles ? '正在解析 PDF' : '批量生成'}
              </Button>
            </Group>
          </Group>
        </>
      ) : (
        <>
          <Paper p="md" radius="xl" withBorder>
            <Stack gap="sm">
              <Group justify="space-between" align="center">
                <Group gap="sm">
                  <Badge color="teal" radius="sm" variant="light">
                    {taskQuery.data?.task.status === 'completed'
                      ? '已完成'
                      : taskQuery.data?.task.status === 'failed'
                        ? '有失败项'
                        : '执行中'}
                  </Badge>
                  <Text size="sm">
                    已完成 {succeededCount} / {taskItems.length}
                  </Text>
                  {failedCount > 0 ? (
                    <Text c="red" size="sm">
                      失败 {failedCount} 项
                    </Text>
                  ) : null}
                </Group>
                <Text c="dimmed" size="sm">
                  任务 ID：{taskId.slice(0, 8)}
                </Text>
              </Group>
              <Progress radius="xl" value={progressValue} />
            </Stack>
          </Paper>

          <Stack gap="md">
            {taskItems.map((item, index) => {
              const clientStartedAt = itemStartedAtRef.current.get(item.id) ?? null;
              const elapsedSeconds = formatElapsedSeconds(item, tick, clientStartedAt);
              const isReviewed = false;
              return (
                <Paper key={item.id} p="md" radius="xl" withBorder>
                  <Stack gap="sm">
                    <Group justify="space-between" align="flex-start">
                      <div>
                        <Text fw={700}>#{index + 1}</Text>
                        <Text size="sm">{item.source_pdf_name}</Text>
                      </div>
                      <Group gap="sm" align="center">
                        <Badge color={getStatusColor(item.status)} radius="sm" variant="light">
                          {getStatusLabel(item.status)}
                        </Badge>
                        <Text size="sm">{elapsedSeconds} 秒</Text>
                      </Group>
                    </Group>

                    {item.error_message ? (
                      <Text c="red" size="sm">
                        {item.error_message}
                      </Text>
                    ) : null}

                    {['uploaded', 'running', 'pending'].includes(item.status) && item.slot_total_count > 0 ? (
                      <Text c="dimmed" size="sm">
                        已完成 {item.slot_completed_count} 个槽位，待抽取 {getPendingSlotCount(item)} 个槽位
                      </Text>
                    ) : null}

                    {item.status === 'review_pending' ? (
                      <>
                        <Divider />
                        <Group justify="space-between" align="center">
                          <Text c="dimmed" size="sm">
                            {isReviewed
                              ? '这个文件已经核查完毕，可以继续查看核查页或直接下载结果。'
                              : '槽位结果已返回。请打开新的核查页确认后，再允许下载结果。'}
                          </Text>
                          <Group>
                            <Button
                              radius="xl"
                              variant={isReviewed ? 'default' : 'light'}
                              onClick={() => {
                                window.open(
                                  `/documents/generation-review/${item.id}`,
                                  '_blank',
                                  'noopener,noreferrer',
                                );
                              }}
                            >
                              {isReviewed ? '查看核查结果' : '去核查'}
                            </Button>
                            {isReviewed ? (
                              <Button
                                radius="xl"
                                variant="default"
                                onClick={() => {
                                  requestReviewedDocxDownload({
                                    taskItemId: item.id,
                                    defaultFileName: `${innerProps.templateName}-${item.source_pdf_name.replace(/\.pdf$/i, '')}-核查结果.docx`,
                                  });
                                }}
                              >
                                下载结果
                              </Button>
                            ) : null}
                          </Group>
                        </Group>
                      </>
                    ) : null}
                  </Stack>
                </Paper>
              );
            })}
          </Stack>

          <Group justify="space-between">
            <Button
              radius="xl"
              variant="subtle"
              onClick={() => {
                void refreshTaskLists();
              }}
            >
              刷新状态
            </Button>
            <Button
              disabled={!canCloseTaskModal}
              radius="xl"
              onClick={closeModalWithRefresh}
            >
              关闭
            </Button>
          </Group>
        </>
      )}
      </Stack>
    </Box>
  );
}
