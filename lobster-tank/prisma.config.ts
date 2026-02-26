import "dotenv/config";
import { defineConfig } from "prisma/config";

export default defineConfig({
  schema: "prisma/schema.prisma",
  datasource: {
    // Migrations: Session pooler (direct unreachable from your network). App uses DATABASE_URL at runtime.
    url: process.env.SESSION_URL ?? process.env.DIRECT_URL ?? process.env.DATABASE_URL,
  },
});
