'use client';

import { Button, Card, Stack, Text, Title } from '@mantine/core';
import { useEffect, useState } from 'react';
import { publishAuthSyncEvent } from '@/src/lib/auth/auth-sync';
import { getSupabaseBrowserClient } from '@/src/lib/supabase/client';

export function AuthCompleteClient() {
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
            <Title order={2}>登录完成</Title>
            <Text c="dimmed" size="sm">
              原来的 ClipCap 页面现在应该已经同步成登录成功状态了。这个页签只是登录完成提示页，可以直接关闭。
            </Text>
          </Stack>

          {isAutoCloseAttempted ? (
            <Stack gap="xs">
              <Text c="dimmed" size="sm">
                如果浏览器没有自动关闭当前页，请点击下面按钮关闭它，然后回到原来的 ClipCap 页面继续使用。
              </Text>
              <Button
                fullWidth
                radius="xl"
                onClick={() => {
                  window.close();
                }}
              >
                关闭当前页
              </Button>
            </Stack>
          ) : null}
        </Stack>
      </Card>
    </main>
  );
}
