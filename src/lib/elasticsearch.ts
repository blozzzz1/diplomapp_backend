import { Client } from '@elastic/elasticsearch';

const ELASTICSEARCH_URL = process.env.ELASTICSEARCH_URL; // e.g. http://localhost:9200

let client: Client | null = null;

export function getElasticsearchClient(): Client | null {
  if (!ELASTICSEARCH_URL) return null;
  if (!client) {
    client = new Client({
      node: ELASTICSEARCH_URL,
      ...(process.env.ELASTICSEARCH_API_KEY && {
        auth: {
          apiKey: process.env.ELASTICSEARCH_API_KEY,
        },
      }),
    });
  }
  return client;
}

export function isElasticsearchEnabled(): boolean {
  return !!ELASTICSEARCH_URL;
}

const INDEX_PREFIX = process.env.ELASTICSEARCH_INDEX_PREFIX || 'backend-logs';

function getIndexName(type: 'request' | 'activity' | 'error'): string {
  const date = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  return `${INDEX_PREFIX}-${type}-${date}`;
}

export interface LogDocument {
  '@timestamp': string;
  level: string;
  type: 'request' | 'activity' | 'error';
  message?: string;
  [key: string]: unknown;
}

/**
 * Отправляет документ в Elasticsearch (fire-and-forget, не блокирует).
 */
export function indexLog(doc: LogDocument): void {
  const es = getElasticsearchClient();
  if (!es) return;

  const index = getIndexName(doc.type);
  es.index({
    index,
    document: doc,
  }).catch((err) => {
    console.error('[Elasticsearch] Failed to index log:', err.message);
  });
}
