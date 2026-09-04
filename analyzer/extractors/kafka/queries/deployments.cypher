MATCH (deployment:DeploymentUnit)
RETURN deployment.id AS deploymentId, deployment.kind AS kind,
       deployment.name AS name, deployment.namespace AS namespace,
       deployment.documentId AS documentId
ORDER BY namespace, name
