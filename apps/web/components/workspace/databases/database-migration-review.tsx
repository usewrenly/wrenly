"use client";
/** Shows exact saved migration bytes and requires a deliberate verified-backup selection. */
import { useEffect, useState } from "react";
import type { DatabaseMigrationReview } from "@wrenly/db/app-database-resource-contract";
import { requestDatabaseMigrationReview } from "@/lib/databases/requests";
import { Button } from "@/components/ui/button";
type Review = DatabaseMigrationReview;
export interface ReviewedDatabaseMigration {
  review: Review;
  backupId: string;
}
/** Parent remounts for project/resource/revision/build changes; no request here executes generated source. */
export function DatabaseMigrationReviewPanel({
  projectId,
  resourceId,
  revision,
  buildId,
  onConfirm,
}: {
  projectId: string;
  resourceId: string;
  revision: string;
  buildId: string;
  onConfirm: (value: ReviewedDatabaseMigration) => void;
}): React.JSX.Element {
  const [review, setReview] = useState<Review | null>(null),
    [failed, setFailed] = useState(false);
  const [reload, setReload] = useState(0);
  const [backupId, setBackupId] = useState(""),
    [confirmed, setConfirmed] = useState(false);
  useEffect(() => {
    setReview(null);
    setFailed(false);
    setBackupId("");
    setConfirmed(false);
    const controller = new AbortController();
    void requestDatabaseMigrationReview(
      projectId,
      resourceId,
      buildId,
      controller.signal,
    )
      .then((value) => {
        if (!controller.signal.aborted) {
          if (value.revision !== revision) setFailed(true);
          else setReview(value);
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) setFailed(true);
      });
    return () => controller.abort();
  }, [projectId, resourceId, revision, buildId, reload]);
  if (failed)
    return (
      <div className="database-review-error">
        <p role="alert">
          This revision’s database changes could not be verified. Review
          requires a successful saved build and the current database revision.
          No database changes were applied.
        </p>
        <Button
          variant="outline"
          onClick={() => setReload((value) => value + 1)}
        >
          Reload review
        </Button>
      </div>
    );
  if (!review)
    return (
      <p role="status">Loading the selected revision’s database changes…</p>
    );
  return (
    <div className="database-migration-review">
      <p>
        Saved revision <code>{review.buildId}</code>
      </p>
      {review.framework === "laravel" ? (
        <p>
          Laravel starts application code during migration. Review the entire
          saved source in Code as well as these migration files.
        </p>
      ) : null}
      <div className="database-migration-files">
        {review.files.map((file) => (
          <details key={file.path}>
            <summary>{file.path}</summary>
            <pre>
              <code>{file.content}</code>
            </pre>
          </details>
        ))}
      </div>
      <fieldset>
        <legend>Choose a restored, verified backup</legend>
        {review.backups.length ? (
          review.backups.map((backup) => (
            <label key={backup.id} className="database-backup-choice">
              <input
                type="radio"
                name="database-backup"
                checked={backupId === backup.id}
                onChange={() => {
                  setBackupId(backup.id);
                  setConfirmed(false);
                }}
              />
              <span>
                {new Date(backup.verifiedAt).toLocaleString()}
                <small>{backup.id}</small>
              </span>
            </label>
          ))
        ) : (
          <p>
            Create a verified backup first, then reopen this review. No database
            changes can be submitted yet.
          </p>
        )}
      </fieldset>
      <label className="database-backup-choice">
        <input
          type="checkbox"
          checked={confirmed}
          disabled={!backupId}
          onChange={(event) => setConfirmed(event.target.checked)}
        />
        <span>
          I reviewed this saved source and understand these changes can alter
          application data.
        </span>
      </label>
      <Button
        disabled={!confirmed || !backupId}
        onClick={() => onConfirm({ review, backupId })}
      >
        Use this reviewed migration
      </Button>
    </div>
  );
}
