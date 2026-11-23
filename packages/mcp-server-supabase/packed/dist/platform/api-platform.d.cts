import { SupabasePlatform } from './index.cjs';
import '@supabase/mcp-utils';
import 'zod/v4';

type SupabaseApiPlatformOptions = {
    /**
     * The access token for the Supabase Management API.
     */
    accessToken: string;
    /**
     * The API URL for the Supabase Management API.
     */
    apiUrl?: string;
};
/**
 * Creates a Supabase platform implementation using the Supabase Management API.
 */
declare function createSupabaseApiPlatform(options: SupabaseApiPlatformOptions): SupabasePlatform;

export { type SupabaseApiPlatformOptions, createSupabaseApiPlatform };
