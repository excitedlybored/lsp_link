MATCH (reference:ConfigurationReference)
RETURN reference.id AS evidenceId, reference.valueId AS valueId,
       reference.targetKey AS targetKey, reference.kind AS kind,
       reference.status AS status
ORDER BY valueId, targetKey, kind
