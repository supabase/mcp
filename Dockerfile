# Use a slim Node.js base image
FROM node:20-slim

# Enable pnpm via corepack
RUN corepack enable

# Set working directory
WORKDIR /app

# Copy root workspace files
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./

# Copy only the required packages
COPY packages/mcp-utils ./packages/mcp-utils
COPY packages/mcp-server-supabase ./packages/mcp-server-supabase

# Install dependencies without running scripts
RUN pnpm install --frozen-lockfile --ignore-scripts

# Build mcp-utils
WORKDIR /app/packages/mcp-utils
RUN pnpm exec tsup --no-dts

# Build mcp-server-supabase
WORKDIR /app/packages/mcp-server-supabase
RUN pnpm exec tsup --no-dts

# Default command: run the MCP server over stdio
CMD ["node", "dist/index.js"]

