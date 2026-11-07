import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { z } from 'zod';

export class ApiError extends Error {
  constructor(
    public status: ContentfulStatusCode,
    public code: string,
    message: string,
    public extra?: Record<string, unknown>,
    public headers?: Record<string, string>,
  ) {
    super(message);
  }
}

export const notFound = (what = 'Resource') => new ApiError(404, 'not_found', `${what} not found`);
export const unauthorized = () => new ApiError(401, 'unauthorized', 'Sign in or continue as guest first');

export function zodMessage(e: z.ZodError): string {
  return e.issues
    .slice(0, 5)
    .map((i) => (i.path.length ? `${i.path.join('.')}: ${i.message}` : i.message))
    .join('; ');
}

/** Parse with zod; throws ApiError 400 invalid_input. */
export function parseInput<T extends z.ZodType>(schema: T, value: unknown): z.infer<T> {
  const r = schema.safeParse(value);
  if (!r.success) throw new ApiError(400, 'invalid_input', zodMessage(r.error));
  return r.data;
}
