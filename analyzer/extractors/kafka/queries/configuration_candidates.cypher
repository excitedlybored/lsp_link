MATCH (value:ConfigurationValue)
RETURN value.id AS evidenceId, value.key AS key, value.rawValue AS rawValue,
       value.resolvedValue AS resolvedValue, value.status AS status,
       value.sourceKind AS sourceKind, value.scope AS scope, value.profileName AS profileName,
       value.precedence AS precedence, value.confidence AS confidence,
       value.documentId AS documentId, value.startLine AS startLine
ORDER BY key, precedence DESC, startLine
