import { HttpError } from './errors.ts';

export type MultipartFile = { filename: string; bytes: Buffer };
export type MultipartForm = { fields: Record<string, string>; files: Record<string, MultipartFile> };

export const parseMultipart = (contentType: string | undefined, body: Buffer): MultipartForm => {
  const boundary = boundaryFrom(contentType);
  const marker = Buffer.from(`--${boundary}`);
  const delimiter = Buffer.from(`\r\n--${boundary}`);
  const result: MultipartForm = { fields: {}, files: {} };
  let start = body.indexOf(marker);
  if (start !== 0) throw badMultipart();
  start += marker.length;
  let parts = 0;

  while (start < body.length) {
    if (body.subarray(start, start + 2).equals(Buffer.from('--'))) return result;
    if (!body.subarray(start, start + 2).equals(Buffer.from('\r\n'))) throw badMultipart();
    start += 2;
    const headerEnd = body.indexOf(Buffer.from('\r\n\r\n'), start);
    if (headerEnd < 0 || headerEnd - start > 8_192) throw badMultipart();
    const next = body.indexOf(delimiter, headerEnd + 4);
    if (next < 0 || ++parts > 10) throw badMultipart();
    const headers = body.subarray(start, headerEnd).toString('latin1');
    const disposition = /^content-disposition:\s*form-data;\s*name="([^"]+)"(?:;\s*filename="([^"]*)")?\s*$/im.exec(headers);
    if (!disposition) throw badMultipart();
    const [, name, filename] = disposition;
    if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(name) || name in result.fields || name in result.files) {
      throw badMultipart();
    }
    const value = body.subarray(headerEnd + 4, next);
    if (filename !== undefined) {
      if (!filename || /[\0\r\n]/.test(filename)) throw badMultipart();
      result.files[name] = { filename, bytes: value };
    } else {
      if (value.byteLength > 4_096) throw badMultipart();
      result.fields[name] = value.toString('utf8');
    }
    start = next + delimiter.length;
  }
  throw badMultipart();
};

const boundaryFrom = (contentType: string | undefined): string => {
  const match = /^multipart\/form-data\s*;\s*boundary=(?:"([^"]+)"|([^;\s]+))\s*$/i.exec(contentType ?? '');
  const boundary = match?.[1] ?? match?.[2] ?? '';
  if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,200}$/.test(boundary)) throw badMultipart();
  return boundary;
};

const badMultipart = (): HttpError => new HttpError(400, 'BAD_REQUEST', '업로드 본문을 읽을 수 없습니다.');
