import { open as openZipFile, type Entry, type ZipFile } from "yauzl";

export async function readZipTextFiles(zipPath: string): Promise<Map<string, string>> {
  const zipFile = await openZip(zipPath);
  const files = new Map<string, string>();

  return await new Promise<Map<string, string>>((resolve, reject) => {
    zipFile.on("error", reject);
    zipFile.readEntry();
    zipFile.on("entry", (entry: Entry) => {
      if (/\/$/.test(entry.fileName)) {
        zipFile.readEntry();
        return;
      }

      zipFile.openReadStream(entry, (error, stream) => {
        if (error) {
          reject(error);
          return;
        }
        if (!stream) {
          reject(new Error(`Unable to open zip entry ${entry.fileName}`));
          return;
        }

        const chunks: Buffer[] = [];
        stream.on("data", (chunk: Buffer) => {
          chunks.push(chunk);
        });
        stream.on("error", reject);
        stream.on("end", () => {
          files.set(entry.fileName, Buffer.concat(chunks).toString("utf8"));
          zipFile.readEntry();
        });
      });
    });
    zipFile.on("end", () => resolve(files));
  });
}

function openZip(zipPath: string): Promise<ZipFile> {
  return new Promise<ZipFile>((resolve, reject) => {
    openZipFile(zipPath, { lazyEntries: true, autoClose: true }, (error, zipFile) => {
      if (error) {
        reject(error);
        return;
      }
      if (!zipFile) {
        reject(new Error(`Unable to open zip file ${zipPath}`));
        return;
      }
      resolve(zipFile);
    });
  });
}
