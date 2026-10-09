/**
 * A failure that came from the mail provider refusing our credentials.
 *
 * This exists to be recognisable. A consumer needs to tell "your provider
 * rejected us" from "that email id does not exist", because the two call for
 * opposite responses: one is a hard stop needing a human to rotate a
 * credential, the other is a bad argument. They used to be indistinguishable --
 * both arrived as a tool error carrying prose -- so an unattended consumer
 * could only retry, which never helps, or give up, which is wrong for the
 * ordinary case.
 *
 * Carried as a class rather than a string pattern because the alternative is
 * matching on the provider's wording, which rots silently while continuing to
 * look authoritative.
 */
export class UpstreamAuthError extends Error {
    readonly status: number;
    /** 'jmap' or 'dav': which credential, since an account can have both. */
    readonly service: string;

    constructor(message: string, options: { status: number; service: string }) {
        super(message);
        this.name = 'UpstreamAuthError';
        this.status = options.status;
        this.service = options.service;
    }
}

/** Whether an error -- or anything it wraps -- is a provider credential refusal. */
export function isUpstreamAuthError(error: unknown): error is UpstreamAuthError {
    let current: unknown = error;
    for (let depth = 0; depth < 5 && current; depth += 1) {
        if (current instanceof UpstreamAuthError) return true;
        // Name check as well as instanceof: the two packages are built
        // separately, and a duplicated module would otherwise make a real
        // UpstreamAuthError unrecognisable across the boundary.
        if ((current as { name?: string }).name === 'UpstreamAuthError') return true;
        current = (current as { cause?: unknown }).cause;
    }
    return false;
}
