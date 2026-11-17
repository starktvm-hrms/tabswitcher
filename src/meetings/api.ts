import { call, type Creds } from '../workspace';

/** Client for meetings: recordings → transcript (ElevenLabs) → minutes (DeepSeek). */

export type JobState = { state: 'none' | 'running' | 'done' | 'error'; error?: string; at?: number; startedAt?: number };
export type MeetingSummary = {
  id: string; title: string; startedAt: number; durationSec: number; audioUrl: string; videoUrl: string | null;
  transcribe: JobState; minutes: JobState; hasTranscript: boolean; hasMinutes: boolean;
};
export type Meeting = MeetingSummary & {
  transcript: { text: string; language?: string; speakers?: number; model?: string; at?: number } | null;
  minutesDoc: { markdown: string; model?: string; instructions?: string; at?: number } | null;
};
export type AiSettings = {
  elevenlabs: { configured: boolean; hint: string | null };
  deepseek: { configured: boolean; hint: string | null; model: string };
};

const base = (c: Creds) => `/${c.id}`;

export const getSettings = (c: Creds) => call<AiSettings>(c, `${base(c)}/settings`);
export const saveSettings = (c: Creds, s: { elevenlabsKey?: string; deepseekKey?: string; deepseekModel?: string }) =>
  call<AiSettings>(c, `${base(c)}/settings`, { method: 'PUT', body: JSON.stringify(s) });

export const listMeetings = (c: Creds) => call<{ meetings: MeetingSummary[] }>(c, `${base(c)}/meetings`).then((r) => r.meetings);
export const getMeeting = (c: Creds, id: string) => call<Meeting>(c, `${base(c)}/meetings/${id}`);
export const createMeeting = (c: Creds, m: { title?: string; audioFileId: string; videoFileId?: string; durationSec: number; startedAt: number }) =>
  call<MeetingSummary>(c, `${base(c)}/meetings`, { method: 'POST', body: JSON.stringify(m) });
export const updateMeeting = (c: Creds, id: string, patch: { title?: string; transcript?: string; minutes?: string }) =>
  call<Meeting>(c, `${base(c)}/meetings/${id}`, { method: 'PATCH', body: JSON.stringify(patch) });
export const deleteMeeting = (c: Creds, id: string) => call<{ ok: true }>(c, `${base(c)}/meetings/${id}`, { method: 'DELETE' });
export const startTranscribe = (c: Creds, id: string, language?: string) =>
  call<MeetingSummary>(c, `${base(c)}/meetings/${id}/transcribe`, { method: 'POST', body: JSON.stringify({ language }) });
export const startMinutes = (c: Creds, id: string, instructions?: string) =>
  call<MeetingSummary>(c, `${base(c)}/meetings/${id}/minutes`, { method: 'POST', body: JSON.stringify({ instructions }) });

/** Saves a Blob as a file on this computer. */
export function download(blob: Blob, name: string) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
}

export const safeName = (s: string) => s.replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, ' ').trim().slice(0, 80) || 'meeting';
