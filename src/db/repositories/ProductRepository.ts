// src/db/repositories/ProductRepository.ts
// Read-only product catalog access (writes are admin-only, handled via Supabase dashboard for now).
// Every query is scoped to client_id via BaseRepository.getTenantQuery().

import { BaseRepository } from './BaseRepository';
import { Product } from '../types';

export class ProductRepository extends BaseRepository {

  /** Return all available products for a client, ordered by name. */
  async getAvailable(clientId: string): Promise<Product[]> {
    const { data, error } = await this.getTenantQuery('products', clientId)
      .eq('stock_status', 'available')
      .order('name', { ascending: true });

    if (error) throw new Error(`[DB] getAvailable products failed: ${error.message}`);
    return (data ?? []) as Product[];
  }

  /** Return all products (including out-of-stock) for a client. */
  async getAll(clientId: string): Promise<Product[]> {
    const { data, error } = await this.getTenantQuery('products', clientId)
      .order('name', { ascending: true });

    if (error) throw new Error(`[DB] getAll products failed: ${error.message}`);
    return (data ?? []) as Product[];
  }

  /** Find a single product by ID, scoped to the client. */
  async getById(clientId: string, productId: string): Promise<Product | null> {
    const { data, error } = await this.getTenantQuery('products', clientId)
      .eq('id', productId)
      .single();

    if (error) {
      if (error.code === 'PGRST116') return null; // not found
      throw new Error(`[DB] getById product failed: ${error.message}`);
    }
    return data as Product;
  }

  /**
   * Simple fuzzy name search — finds products whose name or description
   * contains the search term (case-insensitive). Used by the AI engine
   * to resolve product mentions from customer messages.
   */
  async searchByName(clientId: string, term: string): Promise<Product[]> {
    const { data, error } = await this.getTenantQuery('products', clientId)
      .ilike('name', `%${term}%`);

    if (error) throw new Error(`[DB] searchByName products failed: ${error.message}`);
    return (data ?? []) as Product[];
  }
}
