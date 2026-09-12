import type { Database } from 'better-sqlite3'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { extname, join } from 'node:path'
import { chunkText } from './chunk.js'

export const knowledgeDir = '.agent-hub/knowledge'

const lidos = new Set(['.md', '.txt', '.markdown', '.csv', '.json', '.yaml', '.yml'])

export interface KnowledgeHit {
  file: string
  firstLine: number
  lastLine: number
  text: string
}

export interface IndexResult {
  files: number
  chunks: number
  ignored: string[]
}

/** Indice de busca da base de conhecimento do workspace, em FTS5 do proprio SQLite do daemon. Sem embedding, sem custo. */
export class KnowledgeStore {
  constructor(private readonly db: Database) {}

  static migrate(db: Database): void {
    db.exec(`
      CREATE TABLE IF NOT EXISTS knowledge_files (
        workspace TEXT NOT NULL,
        file TEXT NOT NULL,
        mtime INTEGER NOT NULL,
        chunks INTEGER NOT NULL,
        PRIMARY KEY (workspace, file)
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_chunks USING fts5(
        workspace UNINDEXED,
        file UNINDEXED,
        first_line UNINDEXED,
        last_line UNINDEXED,
        text,
        tokenize = 'unicode61 remove_diacritics 2'
      );
    `)
  }

  /** Reindexa so o que mudou desde a ultima vez, comparando o mtime do arquivo. */
  index(workspace: string): IndexResult {
    const dir = join(workspace, knowledgeDir)
    const out: IndexResult = { files: 0, chunks: 0, ignored: [] }
    if (!existsSync(dir)) return out
    const presentes = new Set<string>()
    for (const nome of readdirSync(dir).sort()) {
      const full = join(dir, nome)
      const info = statSync(full)
      if (!info.isFile()) continue
      if (!lidos.has(extname(nome).toLowerCase())) {
        out.ignored.push(nome)
        continue
      }
      presentes.add(nome)
      const anterior = this.db.prepare('SELECT mtime FROM knowledge_files WHERE workspace = ? AND file = ?').get(workspace, nome) as
        | { mtime: number }
        | undefined
      if (anterior && anterior.mtime === Math.floor(info.mtimeMs)) continue
      const chunks = chunkText(readFileSync(full, 'utf8'))
      const tx = this.db.transaction(() => {
        this.db.prepare('DELETE FROM knowledge_chunks WHERE workspace = ? AND file = ?').run(workspace, nome)
        const insert = this.db.prepare('INSERT INTO knowledge_chunks (workspace, file, first_line, last_line, text) VALUES (?, ?, ?, ?, ?)')
        for (const c of chunks) insert.run(workspace, nome, c.firstLine, c.lastLine, c.text)
        this.db
          .prepare(
            'INSERT INTO knowledge_files (workspace, file, mtime, chunks) VALUES (?, ?, ?, ?) ' +
              'ON CONFLICT(workspace, file) DO UPDATE SET mtime = excluded.mtime, chunks = excluded.chunks',
          )
          .run(workspace, nome, Math.floor(info.mtimeMs), chunks.length)
      })
      tx()
      out.files += 1
      out.chunks += chunks.length
    }
    for (const row of this.db.prepare('SELECT file FROM knowledge_files WHERE workspace = ?').all(workspace) as { file: string }[]) {
      if (presentes.has(row.file)) continue
      this.db.prepare('DELETE FROM knowledge_chunks WHERE workspace = ? AND file = ?').run(workspace, row.file)
      this.db.prepare('DELETE FROM knowledge_files WHERE workspace = ? AND file = ?').run(workspace, row.file)
    }
    return out
  }

  search(workspace: string, query: string, limit = 5): KnowledgeHit[] {
    const termos = fts(query)
    if (!termos) return []
    try {
      return this.db
        .prepare(
          'SELECT file, first_line, last_line, text FROM knowledge_chunks WHERE workspace = ? AND knowledge_chunks MATCH ? ORDER BY rank LIMIT ?',
        )
        .all(workspace, termos, limit)
        .map((r) => {
          const row = r as { file: string; first_line: number; last_line: number; text: string }
          return { file: row.file, firstLine: row.first_line, lastLine: row.last_line, text: row.text }
        })
    } catch {
      return []
    }
  }

  files(workspace: string): { file: string; chunks: number; mtime: number }[] {
    return this.db.prepare('SELECT file, chunks, mtime FROM knowledge_files WHERE workspace = ? ORDER BY file').all(workspace) as {
      file: string
      chunks: number
      mtime: number
    }[]
  }
}

/** Transforma a pergunta em consulta FTS: so palavras, unidas por OR, para nao exigir que todas apareçam. */
function fts(query: string): string {
  const palavras = query
    .toLowerCase()
    .split(/[^\p{L}\p{N}_-]+/u)
    .filter((p) => p.length > 2)
    .slice(0, 12)
  return palavras.length === 0 ? '' : palavras.map((p) => `"${p.replace(/"/g, '')}"`).join(' OR ')
}
