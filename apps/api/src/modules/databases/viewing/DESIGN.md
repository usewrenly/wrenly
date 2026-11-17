
COMPONENT: Production abandoned-reader recovery
PURPOSE: Close an interrupted Production reader's exact owned helpers without replaying its query.
INPUTS: Confirmed original read, current owner session, exact resource revision and verified Production target configuration.
OUTPUTS: Audited helper/socket cleanup and verified unchanged original schema; no old query result or SQL replay.
STEPS:
1. Reuse the existing ordered owner/project/resource recovery claim and kernel lock.
2. Accept only bounded create-socket/read-database effects and their exact socket closure identities.
3. Remove the original labelled query helper/socket using the saved Production scope.
4. Inspect the original private TLS cluster, restricted role policy and schema using trusted metadata checks.
5. Recheck provider binding, revision, ownership and independent cleanup acknowledgement before releasing the blocker.
EDGE CASES: Development retains local runtime identity inspection. Missing Production configuration, changed binding or foreign helper refuses cleanup completion.
ERROR STATES: Cleanup never confirms the old query. Unknown schema or transport results preserve recovery and the original history.
