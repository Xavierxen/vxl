export type ByteReader = {
  read(): Promise<{ done: boolean; value?: Uint8Array }>;
  cancel(reason?: unknown): Promise<void>;
};
export type LeadIn = { head: Uint8Array; skip: number; masked: boolean; found: boolean };
export function looksLikeImage(bytes: Uint8Array): boolean;
export function wrapperLength(bytes: Uint8Array): number;
export function locateMedia(bytes: Uint8Array): { skip: number; masked: boolean } | null;
export function readLeadIn(reader: ByteReader): Promise<LeadIn>;
export function unwrapBody(reader: ByteReader, lead: LeadIn): ReadableStream<Uint8Array>;
