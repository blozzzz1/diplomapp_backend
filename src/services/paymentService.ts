import { supabaseAdmin } from '../config/supabase';

export type PaymentMethod = 'card' | 'sbp';
export type TransactionStatus = 'completed' | 'refunded' | 'cancelled';

export interface Transaction {
  id: string;
  user_id: string;
  plan: string;
  amount_cents: number;
  currency: string;
  payment_method: PaymentMethod;
  status: TransactionStatus;
  created_at: string;
}

const PREMIUM_AMOUNT_CENTS = 160000; // 1600 ₽ в копейках

/** Создать транзакцию оплаты и вернуть её (план на бэкенде вызывающий код выставит через PlanService) */
export async function createTransaction(
  userId: string,
  plan: 'premium',
  paymentMethod: PaymentMethod
): Promise<{ transaction: Transaction | null; error: string | null }> {
  try {
    const { data, error } = await supabaseAdmin
      .from('transactions')
      .insert({
        user_id: userId,
        plan,
        amount_cents: PREMIUM_AMOUNT_CENTS,
        currency: 'RUB',
        payment_method: paymentMethod,
        status: 'completed',
      })
      .select()
      .single();

    if (error) {
      console.error('PaymentService.createTransaction:', error);
      return { transaction: null, error: error.message };
    }
    return { transaction: data as Transaction, error: null };
  } catch (e) {
    console.error('PaymentService.createTransaction:', e);
    return {
      transaction: null,
      error: e instanceof Error ? e.message : 'Unknown error',
    };
  }
}

/** Список транзакций пользователя (последние сначала) */
export async function getTransactionsByUser(
  userId: string
): Promise<{ transactions: Transaction[]; error: string | null }> {
  try {
    const { data, error } = await supabaseAdmin
      .from('transactions')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false });

    if (error) {
      console.error('PaymentService.getTransactionsByUser:', error);
      return { transactions: [], error: error.message };
    }
    return { transactions: (data || []) as Transaction[], error: null };
  } catch (e) {
    console.error('PaymentService.getTransactionsByUser:', e);
    return {
      transactions: [],
      error: e instanceof Error ? e.message : 'Unknown error',
    };
  }
}
