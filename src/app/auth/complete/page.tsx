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

export default async function AuthCompletePage({ searchParams }: AuthCompletePageProps) {
  await searchParams;

  return <AuthCompleteClient />;
}
