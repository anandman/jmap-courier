/**
 * Which identity may send as a given address.
 *
 * Fastmail represents a catch-all domain as a literal wildcard identity, so a
 * real account looks like this:
 *
 *   anand@resistance.net · family@resistance.net · *@resistance.net
 *   anand@eml.cc · *@sunkcost.farm
 *
 * An exact-match-only check rejects every address on a domain the user owns,
 * which is most of how they actually send.
 */

import { describe, it, expect } from 'vitest';
import { matchIdentity } from '../src/index.js';

// Shaped after the live account.
const IDENTITIES = [
    { id: 'i1', email: 'anand@resistance.net' },
    { id: 'i2', email: 'family@resistance.net' },
    { id: 'i3', email: '*@resistance.net' },
    { id: 'i4', email: 'anand@eml.cc' },
    { id: 'i5', email: '*@sunkcost.farm' },
];

describe('matchIdentity', () => {
    it('prefers an exact identity over the domain wildcard', async () => {
        expect(matchIdentity(IDENTITIES, 'anand@resistance.net')?.id).toBe('i1');
        expect(matchIdentity(IDENTITIES, 'family@resistance.net')?.id).toBe('i2');
    });

    it('authorises an arbitrary address on a catch-all domain', () => {
        // The case that mattered: ad-hoc addresses on an owned domain.
        expect(matchIdentity(IDENTITIES, 'anand.whatever@resistance.net')?.id).toBe('i3');
        expect(matchIdentity(IDENTITIES, 'group@resistance.net')?.id).toBe('i3');
    });

    it('refuses an address on a domain granting only one specific mailbox', () => {
        // eml.cc is Fastmail's own domain: anand@eml.cc is granted, the domain
        // is not. Refusing is correct here.
        expect(matchIdentity(IDENTITIES, 'anandsfakeemail@eml.cc')).toBeUndefined();
    });

    it('refuses a domain with no identity at all', () => {
        expect(matchIdentity(IDENTITIES, 'anand@someoneelse.example')).toBeUndefined();
    });

    it('is case-insensitive on both sides', () => {
        expect(matchIdentity(IDENTITIES, 'Anand.Whatever@Resistance.NET')?.id).toBe('i3');
    });

    it('tolerates surrounding whitespace', () => {
        expect(matchIdentity(IDENTITIES, '  group@resistance.net  ')?.id).toBe('i3');
    });

    it('matches on the last @, so a quoted local part cannot shift the domain', () => {
        expect(matchIdentity(IDENTITIES, 'weird@thing@sunkcost.farm')?.id).toBe('i5');
    });

    it('returns nothing for a value that is not an address', () => {
        expect(matchIdentity(IDENTITIES, 'not-an-address')).toBeUndefined();
    });
});
