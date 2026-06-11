/**
 * Парсит multipart-запрос на диск, проверяет model по model_settings,
 * пересобирает FormData и проксирует на AITunnel.
 */
import busboy from 'busboy';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { Request } from 'express';
import { PlanService } from '../services/planService';

const TMP_PREFIX = 'ait-forward-';

function cleanupPaths(paths: string[]) {
  for (const p of paths) {
    try {
      fs.unlinkSync(p);
    } catch {
      /* ignore */
    }
  }
}

type FilePart = {
  fieldname: string;
  filepath: string;
  filename: string;
  mimeType: string;
};

export async function forwardMultipartAfterModelCheck(
  req: Request,
  aitunnelUrl: string,
  options: {
    apiKey: string;
    timeoutMs: number;
    maxFileBytes?: number;
    fetchWithTimeout: (
      url: string,
      init: RequestInit & { timeoutMs?: number }
    ) => Promise<Response>;
  }
): Promise<
  | { ok: true; upstream: Response }
  | { ok: false; status: number; body: Record<string, unknown> }
> {
  const { apiKey, timeoutMs, maxFileBytes = 280 * 1024 * 1024, fetchWithTimeout } = options;
  const contentType = req.headers['content-type'] || '';
  if (!contentType.includes('multipart/form-data')) {
    return {
      ok: false,
      status: 400,
      body: { error: { message: 'Content-Type must be multipart/form-data' } },
    };
  }

  const tmpPaths: string[] = [];
  /** Порядок полей сохраняем (могут повторяться имена, напр. несколько image). */
  const fieldParts: { name: string; value: string }[] = [];
  const files: FilePart[] = [];

  await new Promise<void>((resolve, reject) => {
    const fileDone: Promise<void>[] = [];
    let rejected = false;

    const bb = busboy({
      headers: req.headers,
      limits: { fileSize: maxFileBytes },
    });

    bb.on('field', (name, val) => {
      fieldParts.push({ name, value: val });
    });

    bb.on('file', (fieldname, file, info) => {
      const filename = info.filename || 'upload.bin';
      const filepath = path.join(
        os.tmpdir(),
        `${TMP_PREFIX}${Date.now()}-${Math.random().toString(36).slice(2, 10)}-${filename.replace(/[/\\]/g, '_')}`
      );
      tmpPaths.push(filepath);
      const ws = fs.createWriteStream(filepath);

      const done = new Promise<void>((res, rej) => {
        const fail = (err: Error) => {
          if (!rejected) {
            rejected = true;
            rej(err);
          }
        };
        file.on('limit', () => {
          fail(new Error('FILE_TOO_LARGE'));
        });
        ws.on('finish', () => {
          files.push({
            fieldname,
            filepath,
            filename,
            mimeType: info.mimeType || 'application/octet-stream',
          });
          res();
        });
        ws.on('error', fail);
        file.on('error', fail);
      });
      fileDone.push(done);
      file.pipe(ws);
    });

    bb.on('error', (err) => {
      cleanupPaths(tmpPaths);
      reject(err);
    });

    bb.on('finish', async () => {
      try {
        await Promise.all(fileDone);
        resolve();
      } catch (e) {
        cleanupPaths(tmpPaths);
        reject(e);
      }
    });

    req.pipe(bb);
  }).catch((e) => {
    cleanupPaths(tmpPaths);
    throw e;
  });

  const modelField = [...fieldParts].reverse().find((p) => p.name === 'model');
  const model = (modelField?.value || '').trim();
  if (!model) {
    cleanupPaths(tmpPaths);
    return {
      ok: false,
      status: 400,
      body: { error: { message: 'Поле model обязательно' } },
    };
  }

  if (!(await PlanService.isModelGloballyEnabled(model))) {
    cleanupPaths(tmpPaths);
    return {
      ok: false,
      status: 403,
      body: { error: { message: 'Эта модель отключена администратором.', code: 'MODEL_DISABLED' } },
    };
  }

  try {
    const formData = new FormData();
    for (const { name, value } of fieldParts) {
      formData.append(name, value);
    }
    for (const f of files) {
      const buf = fs.readFileSync(f.filepath);
      const blob = new Blob([buf], { type: f.mimeType });
      formData.append(f.fieldname, blob, f.filename);
    }

    const upstream = await fetchWithTimeout(aitunnelUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
      body: formData,
      timeoutMs,
    });

    return { ok: true, upstream };
  } finally {
    cleanupPaths(tmpPaths);
  }
}
