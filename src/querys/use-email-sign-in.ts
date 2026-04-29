'use client';

import { useMutation } from '@tanstack/react-query';

interface EmailSignInInput {
  email: string;
  redirectTo: string;
  turnstileToken: string;
}

export function useEmailSignIn() {
  return useMutation({
    mutationFn: async (input: EmailSignInInput) => {
      const response = await fetch('/api/auth/email-sign-in', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(input),
      });

      const payload = (await response.json()) as {
        code?: string;
        message?: string;
        data?: {
          ok: boolean;
        };
      };

      if (!response.ok) {
        throw new Error(payload.message ?? (response.statusText || 'Unknown error'));
      }

      return payload;
    },
  });
}
