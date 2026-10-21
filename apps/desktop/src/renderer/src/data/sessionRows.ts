import type { ProjectFolder, SessionItem } from "./mockData";

export interface SessionRow { session: SessionItem; project: string; }

export function sessionRows(folders: ProjectFolder[], query = ""): SessionRow[] {
  const normalize = (value: string) => value.normalize("NFKC").toLocaleLowerCase("zh-CN");
  const keywords = normalize(query).trim().split(/\s+/).filter(Boolean);
  const seen = new Set<string>();
  const timestamp = (session: SessionItem) => {
    const value = session.updatedAt ? Date.parse(session.updatedAt) : 0;
    return Number.isFinite(value) ? value : 0;
  };
  return folders.flatMap(folder => folder.sessions.map(session => ({ session, project: folder.name })))
    .filter(row => {
      if (seen.has(row.session.id)) return false;
      seen.add(row.session.id);
      const text = normalize(`${row.session.title} ${row.project}`);
      return keywords.every(keyword => text.includes(keyword));
    })
    .sort((a, b) => timestamp(b.session) - timestamp(a.session));
}
