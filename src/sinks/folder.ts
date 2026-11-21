/**
 * The folder sink: the run's working copy and the recommended store. Table
 * files sit at the top of the folder, run state under _state/. Each file is
 * written to a temporary name and renamed, so a reader (Power BI, Grafana, a
 * sync client) never sees half a file.
 */

import { mkdir, readFile, rename, writeFile, appendFile } from "node:fs/promises";
import { join } from "node:path";

export class FolderSink {
  constructor(readonly dir: string) {}

  async ensure(): Promise<void> {
    await mkdir(join(this.dir, "_state"), { recursive: true });
  }

  async read(name: string): Promise<string | null> {
    try {
      return await readFile(join(this.dir, name), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async write(name: string, text: string): Promise<void> {
    const target = join(this.dir, name);
    const temp = `${target}.${process.pid}.tmp`;
    await writeFile(temp, text, "utf8");
    await rename(temp, target);
  }

  async append(name: string, text: string): Promise<void> {
    await appendFile(join(this.dir, name), text, "utf8");
  }
}
