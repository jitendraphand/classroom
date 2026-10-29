import fs from 'node:fs';

/**
 * Append-only record of everything the AI teacher did and why (tool, input,
 * outcome), one JSON line per entry, for the school to review after class.
 */
export class Audit {
  constructor(private readonly file: string | null) {}

  write(entry: Record<string, unknown>): void {
    const line = JSON.stringify({ at: new Date().toISOString(), ...entry });
    if (this.file) fs.appendFile(this.file, `${line}\n`, () => undefined);
    else process.stderr.write(`[audit] ${line}\n`);
  }
}
