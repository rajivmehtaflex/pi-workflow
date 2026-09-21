import Database from "better-sqlite3";
import { WorkflowRepository } from "./repository.js";

/** Durable journal facade used by the engine; SQL remains private to the repository. */
export class WorkflowJournal extends WorkflowRepository {
  constructor(db: Database.Database) {
    super(db);
  }
}
