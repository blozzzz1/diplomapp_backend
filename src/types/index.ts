export interface ImageAttachment {
  type: 'url' | 'base64';
  url?: string;
  data?: string;
  mimeType?: string;
}

export interface FileAttachment {
  type: 'url' | 'base64';
  url?: string;
  data?: string;
  mimeType: string;
  filename: string;
  size?: number;
}

export interface Message {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: string | Date;
  model?: string;
  images?: ImageAttachment[];
  files?: FileAttachment[];
}

export interface ChatSession {
  id: string;
  title: string;
  messages: Message[];
  selectedModel: string;
  createdAt: string | Date;
  updatedAt: string | Date;
  userId?: string;
  /** Число сообщений из списка сессий (без загрузки messages JSON) */
  messageCount?: number;
}

export interface DatabaseChatSession {
  id: string;
  user_id: string;
  title: string;
  selected_model: string;
  messages: string | any; // JSONB can be string or object
  created_at: string;
  updated_at: string;
}


