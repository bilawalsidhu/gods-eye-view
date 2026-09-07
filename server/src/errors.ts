export interface ProblemDetails {
  readonly type: string;
  readonly title: string;
  readonly status: number;
  readonly detail: string;
  readonly instance: string;
  readonly correlationId: string;
}

export class HttpProblem extends Error {
  readonly status: number;
  readonly title: string;
  readonly type: string;

  constructor(
    status: number,
    title: string,
    message: string,
    type = 'about:blank',
  ) {
    super(message);
    this.name = 'HttpProblem';
    this.status = status;
    this.title = title;
    this.type = type;
  }
}

interface FastifyLikeError extends Error {
  readonly code?: string;
  readonly statusCode?: number;
}

export function asProblem(error: Error, instance: string, correlationId: string): ProblemDetails {
  const candidate = error as FastifyLikeError;
  if (error instanceof HttpProblem) {
    return {
      type: error.type,
      title: error.title,
      status: error.status,
      detail: error.message,
      instance,
      correlationId,
    };
  }

  if (candidate.code === 'FST_ERR_CTP_BODY_TOO_LARGE') {
    return {
      type: 'https://httpstatuses.com/413',
      title: 'Payload Too Large',
      status: 413,
      detail: 'The request body exceeds the configured limit.',
      instance,
      correlationId,
    };
  }

  const status = candidate.statusCode && candidate.statusCode >= 400 && candidate.statusCode < 500
    ? candidate.statusCode
    : 500;
  return {
    type: `https://httpstatuses.com/${status}`,
    title: status === 500 ? 'Internal Server Error' : 'Bad Request',
    status,
    detail: status === 500 ? 'An unexpected error occurred.' : error.message,
    instance,
    correlationId,
  };
}
