// The one Postgres connection pool (postgres.js), shared by every module. Import `sql` from here;
// never open a second pool. int8 columns come back as numbers, not strings.

import postgres from "postgres";
import { settings } from "./settings";

export const sql = postgres(settings.databaseUrl, {
  max: 10,
  onnotice: () => {},
  types: {
    // int8 → number: ids stay far below 2^53, and string ids leak into JSON as "12".
    bigint: { to: 20, from: [20], serialize: (v: number) => String(v), parse: (v: string) => Number(v) },
  },
});

export type Sql = typeof sql;
