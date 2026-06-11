import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import chatRoutes from './routes/chat';
import generationsRoutes from './routes/generations';
import adminRoutes from './routes/admin';
import userRoutes from './routes/user';
import settingsRoutes from './routes/settings';
import paymentRoutes from './routes/payment';
import transactionsRoutes from './routes/transactions';
import aiProxyRoutes from './routes/aiProxy';
import { requestLogger, RequestWithId } from './middleware/requestLogger';
import { apiGlobalLimiter } from './middleware/rateLimit';
import { appLogger } from './lib/logger';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:5173';

// Trust proxy for accurate IP addresses (before requestLogger for correct IP)
app.set('trust proxy', true);

// Middleware
app.use(cors({
  origin: FRONTEND_URL,
  credentials: true,
}));

// Request logging (requestId + log on finish)
app.use(requestLogger);

// Global API anti-abuse limiter (per IP)
app.use('/api', apiGlobalLimiter);

// AI proxy routes MUST be before express.json() so multipart body is not consumed
app.use('/api/ai', aiProxyRoutes);

// Chat + загрузка сгенерированных изображений (base64 в JSON)
app.use(express.json({ limit: '32mb' }));
app.use(express.urlencoded({ extended: true, limit: '32mb' }));

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// API routes
app.use('/api/chat', chatRoutes);
app.use('/api/generations', generationsRoutes);
app.use('/api/user', userRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/payment', paymentRoutes);
app.use('/api/transactions', transactionsRoutes);

// Error handling middleware
app.use((err: Error, req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const withId = req as RequestWithId;
  appLogger.error({
    message: err.message,
    stack: err.stack,
    requestId: withId.id,
    path: req.path,
    method: req.method,
    userId: (req as express.Request & { userId?: string }).userId,
  });
  res.status(500).json({ error: 'Internal server error' });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Route not found' });
});

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📡 Frontend URL: ${FRONTEND_URL}`);
  console.log(`🌍 Environment: ${process.env.NODE_ENV || 'development'}`);
  if (process.env.ELASTICSEARCH_URL) {
    console.log('📋 Elasticsearch logging enabled');
  }
});

