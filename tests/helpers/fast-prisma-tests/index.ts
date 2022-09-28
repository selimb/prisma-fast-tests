import { PrismaClient } from '@prisma/client'
import { DEFAULT_PG_SCHEMA_NAME } from './constants'
import { maybeRunMigrations } from './fast-migrations'
import { resetDb } from './fast-reset'
import { logTest } from './log-test'
import { TransactionWrapper } from './transaction-wrapper'
import { buildUniquePgSchemaName } from './unique-schema'

// NOTE: This should match the environment variable name used in `schema.prisma`.
const DB_URL_ENV = 'DB_URL' as const
const TEST_PARALLEL = process.env['TEST_PARALLEL'] !== 'false'
const PG_SCHEMA_NAME = TEST_PARALLEL
  ? buildUniquePgSchemaName()
  : DEFAULT_PG_SCHEMA_NAME
const DB_URL = process.env[DB_URL_ENV] + `?schema=${PG_SCHEMA_NAME};`
// Need to set the new value back on `process.env` such that:
// - `spawn` calls to use this as well.
process.env[DB_URL_ENV] = DB_URL

// Easier to initialize this in the module scope since it's needed in `usingDb` as well as the `jest.mock` call below.
const db = new PrismaClient({
  datasources: {
    db: {
      url: DB_URL,
    },
  },
  // You can add additional test-specific options (like `log`) here if you'd like.
})
const txWrapper = new TransactionWrapper(db)

let usingDbCalled = false
let didRunMigrations = false

/**
 * Fixture that must be used for tests that require the database.
 *
 * @param transactional By default (`true`), tests are wrapped in a database
 *   transaction that is rolled back when the test completes, whether it passes or fails.
 *   Inner transactions, i.e. transactions started within tests, are wrapped in a savepoint.
 *
 *   If a test needs to make use of parallel transactions, transactional testing can be disabled with
 *   `false`, in which case the database is instead truncated (which is significaly slower) at
 *   the end of each test .
 */
export function usingDb({
  transactional = true,
}: { transactional?: boolean } = {}): void {
  beforeEach(async () => {
    if (usingDbCalled) {
      throw new Error(`${usingDb.name} already called in the current scope.`)
    }

    // Force a connection to catch errors early (e.g. bad environment or forgot to start postgres).
    await db.$connect()

    if (!didRunMigrations) {
      logTest(`Using ${DB_URL_ENV}=${DB_URL}`)
      await maybeRunMigrations(db)
      didRunMigrations = true
    }

    if (transactional) {
      await txWrapper.startNewTransaction()
    }

    usingDbCalled = true
  })

  afterEach(async () => {
    // This should only happen if an unhandled error was thrown in `beforeEach`,
    // in which case we shouldn't even try to clean up.
    if (!usingDbCalled) {
      return
    }

    if (transactional) {
      await txWrapper.rollbackCurrentTransaction()
    } else {
      await resetDb(db, PG_SCHEMA_NAME)
    }

    await db.$disconnect()

    usingDbCalled = false
  })
}

jest.mock('../../../src/db', () => {
  return {
    getDb: () => {
      if (!usingDbCalled) {
        throw new Error(
          `Tests that interact with the database must call '${usingDb.name}'.`
        )
      }
      return txWrapper.getProxyClient()
    },
  }
})
