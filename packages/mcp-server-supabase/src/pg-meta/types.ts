import { z } from 'zod/v4';

const yesNoSchema = z.enum(['YES', 'NO']).transform((value) => value === 'YES');

export const tableRowSchema = z.object({
  schema: z.string(),
  name: z.string(),
});

export const columnRowSchema = z.object({
  schema: z.string(),
  table: z.string(),
  name: z.string(),
  default_value: z.string().nullable(),
  data_type: z.string(),
  format: z.string(),
  is_identity: yesNoSchema,
  identity_generation: z.enum(['ALWAYS', 'BY DEFAULT']).nullable(),
  is_generated: z
    .enum(['ALWAYS', 'NEVER'])
    .transform((value) => value === 'ALWAYS'),
  is_nullable: yesNoSchema,
  is_updatable: yesNoSchema,
});

export const keyColumnRowSchema = z.object({
  constraint_type: z.enum(['PRIMARY KEY', 'UNIQUE', 'FOREIGN KEY']),
  constraint_name: z.string(),
  schema: z.string(),
  table: z.string(),
  name: z.string(),
  ordinal_position: z.coerce.number().int(),
  target_schema: z.string().nullable(),
  target_table: z.string().nullable(),
  target_name: z.string().nullable(),
});

export const postgresExtensionSchema = z.object({
  name: z.string(),
  schema: z.union([z.string(), z.null()]),
  default_version: z.string(),
  installed_version: z.union([z.string(), z.null()]),
  comment: z.union([z.string(), z.null()]),
});

export type TableRow = z.infer<typeof tableRowSchema>;
export type ColumnRow = z.infer<typeof columnRowSchema>;
export type KeyColumnRow = z.infer<typeof keyColumnRowSchema>;
export type PostgresExtension = z.infer<typeof postgresExtensionSchema>;
