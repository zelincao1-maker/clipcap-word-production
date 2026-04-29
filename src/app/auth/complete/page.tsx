import type { Metadata } from 'next';
import { AuthCompleteClient } from '@/src/app/auth/complete/AuthCompleteClient';

type AuthCompletePageProps = {
  searchParams: Promise<{
    next?: string;
  }>;
};

export const metadata: Metadata = {
  title: '登录完成',
};

function normalizeNextPath(next: string | undefined) {
  if (!next || !next.startsWith('/')) {
    return '/home';
  }

  return next;
}

export default async function AuthCompletePage({ searchParams }: AuthCompletePageProps) {
  const params = await searchParams;
  const nextPath = normalizeNextPath(params.next);

  return <AuthCompleteClient nextPath={nextPath} />;
}
