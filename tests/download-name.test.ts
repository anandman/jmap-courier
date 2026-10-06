/**
 * Filenames that break a download URL.
 *
 * Fastmail's downloadUrl puts the filename in the URL *path*:
 *
 *   https://.../jmap/download/{accountId}/{blobId}/{name}?type={type}
 *
 * A separator in the name percent-encodes to %2F, which servers commonly refuse
 * in a path. Observed live: six Third Bridge remittance PDFs named
 * "Bill Payment_00006163/172.pdf" every one 404'd, while the same blob with the
 * separator replaced returned 48774 bytes.
 */

import { describe, it, expect } from 'vitest';
import { safeDownloadName } from '../src/index.js';

describe('safeDownloadName', () => {
    it('replaces the separator that caused the 404', () => {
        expect(safeDownloadName('Bill Payment_00006163/172.pdf')).toBe(
            'Bill Payment_00006163_172.pdf'
        );
    });

    it('replaces backslashes too, which encode to %5C', () => {
        expect(safeDownloadName('folder\\file.pdf')).toBe('folder_file.pdf');
    });

    it('collapses a run of separators rather than leaving a gap', () => {
        expect(safeDownloadName('a//b')).toBe('a_b');
    });

    it('leaves a name that was already safe alone', () => {
        // Spaces and parentheses encode fine; only separators are the problem.
        expect(safeDownloadName('Remittance Advice (2026).pdf')).toBe(
            'Remittance Advice (2026).pdf'
        );
    });

    it('falls back to a placeholder when there is no name', () => {
        expect(safeDownloadName(undefined)).toBe('download');
        expect(safeDownloadName('')).toBe('download');
    });

    it('falls back when the name was nothing but separators', () => {
        expect(safeDownloadName('/')).toBe('_');
    });
});
