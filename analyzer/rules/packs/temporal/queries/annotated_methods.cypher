MATCH (owner:LspInterfaceSymbol)-[contains:LspRelation]->(method:LspMethodSymbol),
      (document:LspDocument)-[defined:LspRelation]->(owner),
      (document)-[hasHover:LspRelation]->(hover:LspHover)
WHERE contains.kind = 'CONTAINS'
  AND defined.kind = 'DEFINES'
  AND hasHover.kind = 'HAS_HOVER'
  AND (
    (
      hover.requestLine = method.startLine
      AND (
        hover.contents CONTAINS 'io.temporal.workflow.WorkflowMethod'
        OR hover.contents CONTAINS 'io.temporal.workflow.SignalMethod'
        OR hover.contents CONTAINS 'io.temporal.workflow.QueryMethod'
        OR hover.contents CONTAINS 'io.temporal.workflow.UpdateMethod'
      )
    )
    OR (
      hover.requestLine = owner.startLine
      AND hover.contents CONTAINS 'io.temporal.activity.ActivityInterface'
    )
  )
RETURN DISTINCT owner.id AS ownerId,
       owner.name AS ownerName,
       method.id AS methodId,
       method.name AS methodName,
       method.signature AS signature,
       method.uri AS uri,
       method.startLine AS startLine,
       CASE
         WHEN hover.contents CONTAINS 'io.temporal.workflow.WorkflowMethod' THEN 'workflow'
         WHEN hover.contents CONTAINS 'io.temporal.workflow.SignalMethod' THEN 'signal'
         WHEN hover.contents CONTAINS 'io.temporal.workflow.QueryMethod' THEN 'query'
         WHEN hover.contents CONTAINS 'io.temporal.workflow.UpdateMethod' THEN 'update'
         ELSE 'activity'
       END AS methodRole,
       hover.id AS evidenceId,
       1.0 AS confidence
ORDER BY uri, startLine
