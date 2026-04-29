'use client';

import { Button, Card, Group, Stack, Text, Title } from '@mantine/core';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { publishAuthSyncEvent } from '@/src/lib/auth/auth-sync';
import { getSupabaseBrowserClient } from '@/src/lib/supabase/client';

type AuthCompleteClientProps = {
  nextPath: string;
};

export function AuthCompleteClient({ nextPath }: AuthCompleteClientProps) {
  const [isAutoCloseAttempted, setIsAutoCloseAttempted] = useState(false);

  useEffect(() => {
    const supabase = getSupabaseBrowserClient();

    const syncAuthBackToOriginalPage = async () => {
      try {
        await supabase.auth.getUser();
      } catch {
        // Ignore client-side user sync failures and still notify the original page.
      }

      publishAuthSyncEvent();
    };

    void syncAuthBackToOriginalPage();

    const secondSyncTimer = window.setTimeout(() => {
      void syncAuthBackToOriginalPage();
    }, 1200);

    const firstAttemptTimer = window.setTimeout(() => {
      window.close();
    }, 300);

    const secondAttemptTimer = window.setTimeout(() => {
      try {
        window.open('', '_self');
        window.close();
      } catch {
        // Ignore close fallback failures and leave the manual actions visible.
      }
    }, 900);

    const markAttemptedTimer = window.setTimeout(() => {
      setIsAutoCloseAttempted(true);
    }, 1600);

    return () => {
      window.clearTimeout(secondSyncTimer);
      window.clearTimeout(firstAttemptTimer);
      window.clearTimeout(secondAttemptTimer);
      window.clearTimeout(markAttemptedTimer);
    };
  }, []);

  return (
    <main
      style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '24px',
      }}
    >
      <Card
        padding="xl"
        radius="xl"
        withBorder
        style={{ width: 'min(460px, 100%)' }}
      >
        <Stack gap="md">
          <Stack gap="xs">
            <Text c="teal.4" fw={800} size="lg">
              ClipCap
            </Text>
            <Title order={2}>登录已完成</Title>
            <Text c="dimmed" size="sm">
              已经把登录状态同步回原来的页面。当前这个回调页会自动尝试关闭，如果浏览器拦截了关闭操作，可以手动关闭当前页。
            </Text>
          </Stack>

          {isAutoCloseAttempted ? (
            <Group grow>
              <Button
                component={Link}
                href={nextPath}
                radius="xl"
                variant="default"
              >
                继续进入
              </Button>
              <Button
                radius="xl"
                onClick={() => {
                  window.close();
                }}
              >
                关闭当前页
              </Button>
            </Group>
          ) : null}
        </Stack>
      </Card>
    </main>
  );
}
