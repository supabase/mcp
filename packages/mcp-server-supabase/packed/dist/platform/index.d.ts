import { InitData } from '@supabase/mcp-utils';
import { z } from 'zod/v4';

type SuccessResponse = {
    success: true;
};
declare const storageBucketSchema: z.ZodObject<{
    id: z.ZodString;
    name: z.ZodString;
    owner: z.ZodString;
    created_at: z.ZodString;
    updated_at: z.ZodString;
    public: z.ZodBoolean;
}, z.core.$strip>;
declare const storageConfigSchema: z.ZodObject<{
    fileSizeLimit: z.ZodNumber;
    features: z.ZodObject<{
        imageTransformation: z.ZodObject<{
            enabled: z.ZodBoolean;
        }, z.core.$strip>;
        s3Protocol: z.ZodObject<{
            enabled: z.ZodBoolean;
        }, z.core.$strip>;
    }, z.core.$strip>;
}, z.core.$strip>;
declare const organizationSchema: z.ZodObject<{
    id: z.ZodString;
    name: z.ZodString;
    plan: z.ZodOptional<z.ZodString>;
    allowed_release_channels: z.ZodArray<z.ZodString>;
    opt_in_tags: z.ZodArray<z.ZodString>;
}, z.core.$strip>;
declare const projectSchema: z.ZodObject<{
    id: z.ZodString;
    ref: z.ZodString;
    organization_id: z.ZodString;
    organization_slug: z.ZodString;
    name: z.ZodString;
    status: z.ZodString;
    created_at: z.ZodString;
    region: z.ZodString;
}, z.core.$strip>;
declare const branchSchema: z.ZodObject<{
    id: z.ZodString;
    name: z.ZodString;
    project_ref: z.ZodString;
    parent_project_ref: z.ZodString;
    is_default: z.ZodBoolean;
    git_branch: z.ZodOptional<z.ZodString>;
    pr_number: z.ZodOptional<z.ZodNumber>;
    latest_check_run_id: z.ZodOptional<z.ZodNumber>;
    persistent: z.ZodBoolean;
    status: z.ZodEnum<{
        CREATING_PROJECT: "CREATING_PROJECT";
        RUNNING_MIGRATIONS: "RUNNING_MIGRATIONS";
        MIGRATIONS_PASSED: "MIGRATIONS_PASSED";
        MIGRATIONS_FAILED: "MIGRATIONS_FAILED";
        FUNCTIONS_DEPLOYED: "FUNCTIONS_DEPLOYED";
        FUNCTIONS_FAILED: "FUNCTIONS_FAILED";
    }>;
    created_at: z.ZodString;
    updated_at: z.ZodString;
}, z.core.$strip>;
declare const edgeFunctionSchema: z.ZodObject<{
    id: z.ZodString;
    slug: z.ZodString;
    name: z.ZodString;
    status: z.ZodString;
    version: z.ZodNumber;
    created_at: z.ZodOptional<z.ZodNumber>;
    updated_at: z.ZodOptional<z.ZodNumber>;
    verify_jwt: z.ZodOptional<z.ZodBoolean>;
    import_map: z.ZodOptional<z.ZodBoolean>;
    import_map_path: z.ZodOptional<z.ZodString>;
    entrypoint_path: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
declare const edgeFunctionWithBodySchema: z.ZodObject<{
    id: z.ZodString;
    slug: z.ZodString;
    name: z.ZodString;
    status: z.ZodString;
    version: z.ZodNumber;
    created_at: z.ZodOptional<z.ZodNumber>;
    updated_at: z.ZodOptional<z.ZodNumber>;
    verify_jwt: z.ZodOptional<z.ZodBoolean>;
    import_map: z.ZodOptional<z.ZodBoolean>;
    import_map_path: z.ZodOptional<z.ZodString>;
    entrypoint_path: z.ZodOptional<z.ZodString>;
    files: z.ZodArray<z.ZodObject<{
        name: z.ZodString;
        content: z.ZodString;
    }, z.core.$strip>>;
}, z.core.$strip>;
declare const createProjectOptionsSchema: z.ZodObject<{
    name: z.ZodString;
    organization_id: z.ZodString;
    region: z.ZodEnum<{
        "us-west-1": "us-west-1";
        "us-east-1": "us-east-1";
        "us-east-2": "us-east-2";
        "ca-central-1": "ca-central-1";
        "eu-west-1": "eu-west-1";
        "eu-west-2": "eu-west-2";
        "eu-west-3": "eu-west-3";
        "eu-central-1": "eu-central-1";
        "eu-central-2": "eu-central-2";
        "eu-north-1": "eu-north-1";
        "ap-south-1": "ap-south-1";
        "ap-southeast-1": "ap-southeast-1";
        "ap-northeast-1": "ap-northeast-1";
        "ap-northeast-2": "ap-northeast-2";
        "ap-southeast-2": "ap-southeast-2";
        "sa-east-1": "sa-east-1";
    }>;
    db_pass: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
declare const createBranchOptionsSchema: z.ZodObject<{
    name: z.ZodString;
}, z.core.$strip>;
declare const resetBranchOptionsSchema: z.ZodObject<{
    migration_version: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
declare const deployEdgeFunctionOptionsSchema: z.ZodObject<{
    name: z.ZodString;
    entrypoint_path: z.ZodString;
    import_map_path: z.ZodOptional<z.ZodString>;
    verify_jwt: z.ZodOptional<z.ZodBoolean>;
    files: z.ZodArray<z.ZodObject<{
        name: z.ZodString;
        content: z.ZodString;
    }, z.core.$strip>>;
}, z.core.$strip>;
declare class ResultTooLargeError extends Error {
    name: string;
}
declare const executeSqlOptionsSchema: z.ZodObject<{
    query: z.ZodString;
    parameters: z.ZodOptional<z.ZodArray<z.ZodUnknown>>;
    read_only: z.ZodOptional<z.ZodBoolean>;
    max_result_bytes: z.ZodOptional<z.ZodNumber>;
}, z.core.$strip>;
declare const applyMigrationOptionsSchema: z.ZodObject<{
    name: z.ZodString;
    query: z.ZodString;
}, z.core.$strip>;
declare const migrationSchema: z.ZodObject<{
    version: z.ZodString;
    name: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
declare const logsServiceSchema: z.ZodEnum<{
    storage: "storage";
    api: "api";
    "branch-action": "branch-action";
    postgres: "postgres";
    "edge-function": "edge-function";
    "edge-function-runtime": "edge-function-runtime";
    auth: "auth";
    realtime: "realtime";
}>;
declare const getLogsOptionsSchema: z.ZodObject<{
    service: z.ZodEnum<{
        storage: "storage";
        api: "api";
        "branch-action": "branch-action";
        postgres: "postgres";
        "edge-function": "edge-function";
        "edge-function-runtime": "edge-function-runtime";
        auth: "auth";
        realtime: "realtime";
    }>;
    iso_timestamp_start: z.ZodOptional<z.ZodString>;
    iso_timestamp_end: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
declare const queryLogsOptionsSchema: z.ZodObject<{
    sql: z.ZodString;
    iso_timestamp_start: z.ZodOptional<z.ZodString>;
    iso_timestamp_end: z.ZodOptional<z.ZodString>;
    max_result_bytes: z.ZodOptional<z.ZodNumber>;
}, z.core.$strip>;
declare const generateTypescriptTypesResultSchema: z.ZodObject<{
    types: z.ZodString;
}, z.core.$strip>;
declare const notebookCellSchema: z.ZodDiscriminatedUnion<[z.ZodObject<{
    id: z.ZodString;
    type: z.ZodLiteral<"markdown">;
    text: z.ZodString;
}, z.core.$strip>, z.ZodObject<{
    id: z.ZodString;
    type: z.ZodLiteral<"database">;
    sql: z.ZodString;
    row_limit: z.ZodNumber;
    database_identifier: z.ZodOptional<z.ZodString>;
    title: z.ZodOptional<z.ZodString>;
    view: z.ZodOptional<z.ZodEnum<{
        table: "table";
        chart: "chart";
    }>>;
    chart: z.ZodOptional<z.ZodObject<{
        type: z.ZodEnum<{
            bar: "bar";
            line: "line";
        }>;
        x_column: z.ZodString;
        y_series: z.ZodArray<z.ZodObject<{
            column: z.ZodString;
        }, z.core.$strip>>;
        scale: z.ZodEnum<{
            linear: "linear";
            log: "log";
        }>;
        cumulative: z.ZodBoolean;
        show_labels: z.ZodBoolean;
    }, z.core.$strip>>;
}, z.core.$strip>, z.ZodObject<{
    id: z.ZodString;
    type: z.ZodLiteral<"log">;
    sql: z.ZodString;
    time_range: z.ZodUnion<readonly [z.ZodObject<{
        type: z.ZodLiteral<"absolute">;
        start: z.ZodString;
        end: z.ZodString;
    }, z.core.$strip>, z.ZodObject<{
        type: z.ZodLiteral<"relative">;
        unit: z.ZodEnum<{
            minute: "minute";
            hour: "hour";
            day: "day";
            week: "week";
            month: "month";
            year: "year";
        }>;
        amount: z.ZodNumber;
    }, z.core.$strip>]>;
    title: z.ZodOptional<z.ZodString>;
    view: z.ZodOptional<z.ZodEnum<{
        table: "table";
        chart: "chart";
    }>>;
    chart: z.ZodOptional<z.ZodObject<{
        type: z.ZodEnum<{
            bar: "bar";
            line: "line";
        }>;
        x_column: z.ZodString;
        y_series: z.ZodArray<z.ZodObject<{
            column: z.ZodString;
        }, z.core.$strip>>;
        scale: z.ZodEnum<{
            linear: "linear";
            log: "log";
        }>;
        cumulative: z.ZodBoolean;
        show_labels: z.ZodBoolean;
    }, z.core.$strip>>;
}, z.core.$strip>], "type">;
declare const createNotebookOptionsSchema: z.ZodObject<{
    name: z.ZodString;
    description: z.ZodOptional<z.ZodString>;
    content: z.ZodObject<{
        cells: z.ZodArray<z.ZodDiscriminatedUnion<[z.ZodObject<{
            type: z.ZodLiteral<"markdown">;
            text: z.ZodString;
        }, z.core.$strict>, z.ZodObject<{
            type: z.ZodLiteral<"database">;
            title: z.ZodOptional<z.ZodString>;
            view: z.ZodOptional<z.ZodEnum<{
                table: "table";
                chart: "chart";
            }>>;
            sql: z.ZodString;
            row_limit: z.ZodNumber;
            database_identifier: z.ZodOptional<z.ZodString>;
            chart: z.ZodOptional<z.ZodObject<{
                type: z.ZodEnum<{
                    bar: "bar";
                    line: "line";
                }>;
                x_column: z.ZodString;
                scale: z.ZodEnum<{
                    linear: "linear";
                    log: "log";
                }>;
                cumulative: z.ZodBoolean;
                show_labels: z.ZodBoolean;
                y_series: z.ZodArray<z.ZodObject<{
                    column: z.ZodString;
                }, z.core.$strict>>;
            }, z.core.$strict>>;
        }, z.core.$strict>, z.ZodObject<{
            type: z.ZodLiteral<"log">;
            title: z.ZodOptional<z.ZodString>;
            view: z.ZodOptional<z.ZodEnum<{
                table: "table";
                chart: "chart";
            }>>;
            sql: z.ZodString;
            time_range: z.ZodDiscriminatedUnion<[z.ZodObject<{
                type: z.ZodLiteral<"absolute">;
                start: z.ZodISODateTime;
                end: z.ZodISODateTime;
            }, z.core.$strict>, z.ZodObject<{
                type: z.ZodLiteral<"relative">;
                unit: z.ZodEnum<{
                    minute: "minute";
                    hour: "hour";
                    day: "day";
                    week: "week";
                    month: "month";
                    year: "year";
                }>;
                amount: z.ZodNumber;
            }, z.core.$strict>], "type">;
            chart: z.ZodOptional<z.ZodObject<{
                type: z.ZodEnum<{
                    bar: "bar";
                    line: "line";
                }>;
                x_column: z.ZodString;
                scale: z.ZodEnum<{
                    linear: "linear";
                    log: "log";
                }>;
                cumulative: z.ZodBoolean;
                show_labels: z.ZodBoolean;
                y_series: z.ZodArray<z.ZodObject<{
                    column: z.ZodString;
                }, z.core.$strict>>;
            }, z.core.$strict>>;
        }, z.core.$strict>], "type">>;
    }, z.core.$strip>;
}, z.core.$strip>;
declare const notebookSchema: z.ZodObject<{
    id: z.ZodString;
    name: z.ZodString;
    description: z.ZodNullable<z.ZodString>;
    favorite: z.ZodBoolean;
    inserted_at: z.ZodString;
    updated_at: z.ZodString;
    owner: z.ZodNullable<z.ZodObject<{
        id: z.ZodNumber;
        username: z.ZodString;
    }, z.core.$strip>>;
    updated_by: z.ZodNullable<z.ZodObject<{
        id: z.ZodNumber;
        username: z.ZodString;
    }, z.core.$strip>>;
}, z.core.$strip>;
declare const notebookWithContentSchema: z.ZodObject<{
    id: z.ZodString;
    name: z.ZodString;
    description: z.ZodNullable<z.ZodString>;
    favorite: z.ZodBoolean;
    inserted_at: z.ZodString;
    updated_at: z.ZodString;
    owner: z.ZodNullable<z.ZodObject<{
        id: z.ZodNumber;
        username: z.ZodString;
    }, z.core.$strip>>;
    updated_by: z.ZodNullable<z.ZodObject<{
        id: z.ZodNumber;
        username: z.ZodString;
    }, z.core.$strip>>;
    content: z.ZodObject<{
        schema_version: z.ZodNumber;
        cells: z.ZodArray<z.ZodDiscriminatedUnion<[z.ZodObject<{
            id: z.ZodString;
            type: z.ZodLiteral<"markdown">;
            text: z.ZodString;
        }, z.core.$strip>, z.ZodObject<{
            id: z.ZodString;
            type: z.ZodLiteral<"database">;
            sql: z.ZodString;
            row_limit: z.ZodNumber;
            database_identifier: z.ZodOptional<z.ZodString>;
            title: z.ZodOptional<z.ZodString>;
            view: z.ZodOptional<z.ZodEnum<{
                table: "table";
                chart: "chart";
            }>>;
            chart: z.ZodOptional<z.ZodObject<{
                type: z.ZodEnum<{
                    bar: "bar";
                    line: "line";
                }>;
                x_column: z.ZodString;
                y_series: z.ZodArray<z.ZodObject<{
                    column: z.ZodString;
                }, z.core.$strip>>;
                scale: z.ZodEnum<{
                    linear: "linear";
                    log: "log";
                }>;
                cumulative: z.ZodBoolean;
                show_labels: z.ZodBoolean;
            }, z.core.$strip>>;
        }, z.core.$strip>, z.ZodObject<{
            id: z.ZodString;
            type: z.ZodLiteral<"log">;
            sql: z.ZodString;
            time_range: z.ZodUnion<readonly [z.ZodObject<{
                type: z.ZodLiteral<"absolute">;
                start: z.ZodString;
                end: z.ZodString;
            }, z.core.$strip>, z.ZodObject<{
                type: z.ZodLiteral<"relative">;
                unit: z.ZodEnum<{
                    minute: "minute";
                    hour: "hour";
                    day: "day";
                    week: "week";
                    month: "month";
                    year: "year";
                }>;
                amount: z.ZodNumber;
            }, z.core.$strip>]>;
            title: z.ZodOptional<z.ZodString>;
            view: z.ZodOptional<z.ZodEnum<{
                table: "table";
                chart: "chart";
            }>>;
            chart: z.ZodOptional<z.ZodObject<{
                type: z.ZodEnum<{
                    bar: "bar";
                    line: "line";
                }>;
                x_column: z.ZodString;
                y_series: z.ZodArray<z.ZodObject<{
                    column: z.ZodString;
                }, z.core.$strip>>;
                scale: z.ZodEnum<{
                    linear: "linear";
                    log: "log";
                }>;
                cumulative: z.ZodBoolean;
                show_labels: z.ZodBoolean;
            }, z.core.$strip>>;
        }, z.core.$strip>], "type">>;
    }, z.core.$strip>;
}, z.core.$strip>;
type Organization = z.infer<typeof organizationSchema>;
type Project = z.infer<typeof projectSchema>;
/** The project detail endpoint also reports the database engine. */
type ProjectDetail = Project & {
    database?: {
        postgres_engine?: string;
    };
};
type Branch = z.infer<typeof branchSchema>;
type EdgeFunction = z.infer<typeof edgeFunctionSchema>;
type EdgeFunctionWithBody = z.infer<typeof edgeFunctionWithBodySchema>;
type CreateProjectOptions = z.infer<typeof createProjectOptionsSchema>;
type CreateBranchOptions = z.infer<typeof createBranchOptionsSchema>;
type ResetBranchOptions = z.infer<typeof resetBranchOptionsSchema>;
type DeployEdgeFunctionOptions = z.infer<typeof deployEdgeFunctionOptionsSchema>;
type ExecuteSqlOptions = z.infer<typeof executeSqlOptionsSchema>;
type ApplyMigrationOptions = z.infer<typeof applyMigrationOptionsSchema>;
type Migration = z.infer<typeof migrationSchema>;
type ListMigrationsResult = z.infer<typeof migrationSchema>;
type LogsService = z.infer<typeof logsServiceSchema>;
type GetLogsOptions = z.infer<typeof getLogsOptionsSchema>;
type QueryLogsOptions = z.infer<typeof queryLogsOptionsSchema>;
type GenerateTypescriptTypesResult = z.infer<typeof generateTypescriptTypesResultSchema>;
type StorageConfig = z.infer<typeof storageConfigSchema>;
type StorageBucket = z.infer<typeof storageBucketSchema>;
type NotebookCell = z.infer<typeof notebookCellSchema>;
type CreateNotebookOptions = z.infer<typeof createNotebookOptionsSchema>;
type Notebook = z.infer<typeof notebookSchema>;
type NotebookWithContent = z.infer<typeof notebookWithContentSchema>;
type DatabaseOperations = {
    executeSql<T>(projectId: string, options: ExecuteSqlOptions): Promise<T[]>;
    listMigrations(projectId: string): Promise<Migration[]>;
    applyMigration(projectId: string, options: ApplyMigrationOptions): Promise<void>;
};
type AccountOperations = {
    listOrganizations(): Promise<{
        id: string;
        slug: string;
        name: string;
    }[]>;
    getOrganization(organizationId: string): Promise<Organization>;
    listProjects(): Promise<Project[]>;
    getProject(projectId: string): Promise<ProjectDetail>;
    createProject(options: CreateProjectOptions): Promise<Project>;
    pauseProject(projectId: string): Promise<void>;
    restoreProject(projectId: string): Promise<void>;
};
type EdgeFunctionsOperations = {
    listEdgeFunctions(projectId: string): Promise<EdgeFunction[]>;
    getEdgeFunction(projectId: string, functionSlug: string): Promise<EdgeFunctionWithBody>;
    deployEdgeFunction(projectId: string, options: DeployEdgeFunctionOptions): Promise<Omit<EdgeFunction, 'files'>>;
};
/**
 * SQL dialect that a platform's logs endpoint speaks. Selects the
 * dialect-appropriate `query_logs` description and `sql` parameter hint so a
 * single tool can roll out across environments that back logs with different
 * engines (hosted ClickHouse vs. self-hosted/CLI BigQuery).
 */
type LogsDialect = 'clickhouse' | 'bigquery';
type DebuggingOperations = {
    /**
     * SQL dialect accepted by `queryLogs`. Defaults to `'clickhouse'` when unset,
     * preserving the behavior of platforms that predate this field.
     */
    logsDialect?: LogsDialect;
    getLogs(projectId: string, options: GetLogsOptions): Promise<unknown>;
    queryLogs?(projectId: string, options: QueryLogsOptions): Promise<unknown>;
    getSecurityAdvisors(projectId: string): Promise<unknown>;
    getPerformanceAdvisors(projectId: string): Promise<unknown>;
    getHealthAdvisors?(projectId: string): Promise<unknown>;
};
declare const apiKeyTypeSchema: z.ZodEnum<{
    legacy: "legacy";
    publishable: "publishable";
}>;
type ApiKeyType = z.infer<typeof apiKeyTypeSchema>;
type ApiKey = {
    api_key: string;
    name: string;
    type: ApiKeyType;
    description?: string;
    id?: string;
    disabled?: boolean;
};
type DevelopmentOperations = {
    getProjectUrl(projectId: string): Promise<string>;
    getPublishableKeys(projectId: string): Promise<ApiKey[]>;
    generateTypescriptTypes(projectId: string): Promise<GenerateTypescriptTypesResult>;
};
type StorageOperations = {
    getStorageConfig(projectId: string): Promise<StorageConfig>;
    updateStorageConfig(projectId: string, config: StorageConfig): Promise<void>;
    listAllBuckets(projectId: string): Promise<StorageBucket[]>;
};
type BranchingOperations = {
    listBranches(projectId: string): Promise<Branch[]>;
    createBranch(projectId: string, options: CreateBranchOptions): Promise<Branch>;
    deleteBranch(branchId: string): Promise<void>;
    mergeBranch(branchId: string): Promise<void>;
    resetBranch(branchId: string, options: ResetBranchOptions): Promise<void>;
    rebaseBranch(branchId: string): Promise<void>;
};
/**
 * Returns only the `updated_at` timestamp of the named secret, never its
 * value or digest.
 */
type SecretOperations = {
    getUpdatedAt(projectId: string, name: string): Promise<Date | undefined>;
};
type NotebookOperations = {
    /** Optional for platforms that only support reading notebooks. */
    createNotebook?(projectId: string, options: CreateNotebookOptions): Promise<NotebookWithContent>;
    listNotebooks(projectId: string): Promise<Notebook[]>;
    getNotebook(projectId: string, notebookId: string): Promise<NotebookWithContent>;
    deleteNotebook(projectId: string, notebookId: string): Promise<void>;
};
type FeedbackOperations = {
    submit(input: {
        feedback: string;
        projectId?: string;
        clientInfo?: {
            name: string;
            version: string;
        };
    }): Promise<{
        deleteToken: string;
    }>;
    delete(input: {
        deleteToken: string;
        projectId?: string;
    }): Promise<{
        deleted: boolean;
    }>;
};
type SupabasePlatform = {
    init?(info: InitData): Promise<void>;
    account?: AccountOperations;
    database?: DatabaseOperations;
    functions?: EdgeFunctionsOperations;
    debugging?: DebuggingOperations;
    development?: DevelopmentOperations;
    storage?: StorageOperations;
    branching?: BranchingOperations;
    secrets?: SecretOperations;
    notebooks?: NotebookOperations;
    feedback?: FeedbackOperations;
};

export { type AccountOperations, type ApiKey, type ApiKeyType, type ApplyMigrationOptions, type Branch, type BranchingOperations, type CreateBranchOptions, type CreateNotebookOptions, type CreateProjectOptions, type DatabaseOperations, type DebuggingOperations, type DeployEdgeFunctionOptions, type DevelopmentOperations, type EdgeFunction, type EdgeFunctionWithBody, type EdgeFunctionsOperations, type ExecuteSqlOptions, type FeedbackOperations, type GenerateTypescriptTypesResult, type GetLogsOptions, type ListMigrationsResult, type LogsDialect, type LogsService, type Migration, type Notebook, type NotebookCell, type NotebookOperations, type NotebookWithContent, type Organization, type Project, type ProjectDetail, type QueryLogsOptions, type ResetBranchOptions, ResultTooLargeError, type SecretOperations, type StorageBucket, type StorageConfig, type StorageOperations, type SuccessResponse, type SupabasePlatform, apiKeyTypeSchema, applyMigrationOptionsSchema, branchSchema, createBranchOptionsSchema, createNotebookOptionsSchema, createProjectOptionsSchema, deployEdgeFunctionOptionsSchema, edgeFunctionSchema, edgeFunctionWithBodySchema, executeSqlOptionsSchema, generateTypescriptTypesResultSchema, getLogsOptionsSchema, logsServiceSchema, migrationSchema, notebookCellSchema, notebookSchema, notebookWithContentSchema, organizationSchema, projectSchema, queryLogsOptionsSchema, resetBranchOptionsSchema, storageBucketSchema, storageConfigSchema };
