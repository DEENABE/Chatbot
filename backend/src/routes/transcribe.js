import { Router } from 'express';
import multer from 'multer';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { config } from '../config.js';
import { transcribeLocalWav } from '../services/speechService.js';

const audioUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024, files: 1 }
});

export const transcribeRouter = Router();

transcribeRouter.post(
  '/',
  audioUpload.single('audio'),
  async (request, response, next) => {
    if (!request.file) {
      return response.status(400).json({ error: 'A WAV recording is required.' });
    }
    const audioPath = path.join(config.uploadDir, `voice-${randomUUID()}.wav`);
    try {
      await fs.writeFile(audioPath, request.file.buffer);
      const text = await transcribeLocalWav(audioPath);
      response.json({ text });
    } catch (error) {
      next(error);
    } finally {
      await fs.rm(audioPath, { force: true }).catch(() => {});
    }
  }
);
