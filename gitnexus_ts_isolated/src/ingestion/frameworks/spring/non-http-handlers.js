import { resolveCallerGraphId } from '../../scope-resolution/graph-bridge/ids.js';
import { createSpringAnnotationNameResolver } from './bean-candidates.js';
import { SPRING_BEAN_ANNOTATION } from './bean-factories.js';
export const SPRING_NON_HTTP_HANDLER_ENTRY_POINT_MULTIPLIER = 3.0;
const SPRING_SERVICE_ACTIVATOR_ANNOTATION = 'org.springframework.integration.annotation.ServiceActivator';
const HANDLER_ANNOTATIONS = new Map([
    ['org.springframework.scheduling.annotation.Scheduled', 'scheduled'],
    ['org.springframework.scheduling.annotation.Schedules', 'scheduled'],
    ['org.springframework.context.event.EventListener', 'event'],
    ['org.springframework.transaction.event.TransactionalEventListener', 'event'],
    ['org.springframework.modulith.events.ApplicationModuleListener', 'event'],
    ['org.springframework.kafka.annotation.KafkaListener', 'message'],
    ['org.springframework.kafka.annotation.KafkaListeners', 'message'],
    ['org.springframework.amqp.rabbit.annotation.RabbitListener', 'message'],
    ['org.springframework.amqp.rabbit.annotation.RabbitListeners', 'message'],
    ['org.springframework.jms.annotation.JmsListener', 'message'],
    ['org.springframework.jms.annotation.JmsListeners', 'message'],
    ['org.springframework.pulsar.annotation.PulsarListener', 'message'],
    ['org.springframework.pulsar.annotation.PulsarListeners', 'message'],
    ['io.awspring.cloud.sqs.annotation.SqsListener', 'message'],
    ['io.awspring.cloud.messaging.listener.annotation.SqsListener', 'message'],
    ['org.springframework.cloud.aws.messaging.listener.annotation.SqsListener', 'message'],
    ['org.springframework.cloud.stream.annotation.StreamListener', 'message'],
    [SPRING_SERVICE_ACTIVATOR_ANNOTATION, 'message'],
    ['org.springframework.messaging.handler.annotation.MessageMapping', 'message'],
    ['org.springframework.messaging.simp.annotation.SubscribeMapping', 'message'],
    ['com.xxl.job.core.handler.annotation.XxlJob', 'xxl-job'],
]);
const RECOGNIZED_HANDLER_ANNOTATIONS = new Set(HANDLER_ANNOTATIONS.keys());
const RESOLVABLE_NON_HTTP_ANNOTATIONS = new Set([
    ...RECOGNIZED_HANDLER_ANNOTATIONS,
    SPRING_BEAN_ANNOTATION,
]);
function simpleName(name) {
    const separator = name.lastIndexOf('.');
    return separator === -1 ? name : name.slice(separator + 1);
}
const CAPTURE_RELEVANT_SIMPLE_NAMES = new Set([...RECOGNIZED_HANDLER_ANNOTATIONS].map(simpleName));
export function hasSpringNonHttpHandlerRelevantAnnotation(annotations) {
    return annotations.some((annotation) => CAPTURE_RELEVANT_SIMPLE_NAMES.has(simpleName(annotation.name)));
}
function exactCallableOwnersByRange(graph) {
    const owners = new Map();
    for (const node of graph.iterNodes()) {
        if ((node.label !== 'Method' && node.label !== 'Function') ||
            typeof node.properties.filePath !== 'string') {
            continue;
        }
        const key = `${node.properties.filePath}\0${node.properties.startLine}\0${node.properties.endLine}`;
        owners.set(key, owners.has(key) ? null : node);
    }
    return owners;
}
function ownerGraphNode(fact, indexes, nodeLookup, graph, getExactOwnerByRange) {
    const ownerId = resolveCallerGraphId(fact.ownerScopeId, indexes, nodeLookup);
    if (ownerId !== undefined) {
        const owner = graph.getNode(ownerId);
        if (owner?.label === 'Method' || owner?.label === 'Function')
            return owner;
    }
    if (fact.ownerFilePath !== undefined && fact.ownerRange !== undefined) {
        const fallback = getExactOwnerByRange().get(`${fact.ownerFilePath}\0${fact.ownerRange.startLine - 1}\0${fact.ownerRange.endLine - 1}`);
        if (fallback !== null && fallback !== undefined)
            return fallback;
    }
    return undefined;
}
function handlerReason(kinds) {
    if (kinds.size !== 1) {
        return kinds.has('xxl-job') ? 'managed-non-http-handler' : 'spring-non-http-handler';
    }
    const kind = kinds.values().next().value;
    if (kind === 'xxl-job')
        return 'xxl-job-handler';
    return `spring-${kind}-handler`;
}
/**
 * Resolve callable annotations after imports and package visibility finalize,
 * then promote confirmed framework-managed handlers into process entry points.
 */
export function createSpringNonHttpHandlerMetadataAttacher(adapter) {
    return (graph, parsedFiles, nodeLookup, indexes) => {
        const factsByFile = new Map();
        for (const parsed of parsedFiles) {
            const facts = adapter.getFacts(parsed.filePath);
            if (facts.length > 0)
                factsByFile.set(parsed.filePath, facts);
        }
        if (factsByFile.size === 0)
            return;
        const resolveAnnotation = createSpringAnnotationNameResolver(indexes);
        let exactOwnerByRange;
        const getExactOwnerByRange = () => (exactOwnerByRange ??= exactCallableOwnersByRange(graph));
        let classIdByMethod;
        const ownerClassLabel = (methodId) => {
            if (classIdByMethod === undefined) {
                const owners = new Map();
                for (const relationship of graph.iterRelationshipsByType('HAS_METHOD')) {
                    owners.set(relationship.targetId, relationship.sourceId);
                }
                classIdByMethod = owners;
            }
            const classId = classIdByMethod.get(methodId);
            return classId === undefined ? undefined : graph.getNode(classId)?.label;
        };
        for (const parsed of parsedFiles) {
            const facts = factsByFile.get(parsed.filePath);
            if (facts === undefined)
                continue;
            const incomplete = adapter.isPackageVisibilityIncomplete(parsed.filePath);
            const resolvedAnnotations = new Map();
            for (const fact of facts) {
                const ownerScope = indexes.scopeTree.getScope(fact.ownerScopeId);
                const resolvedFactAnnotations = new Set();
                for (const annotation of fact.annotations) {
                    if (annotation.useSiteTarget !== undefined)
                        continue;
                    const enclosingScope = ownerScope?.parent ?? null;
                    const cacheKey = `${enclosingScope ?? '<root>'}\0${annotation.name}`;
                    let resolved = resolvedAnnotations.get(cacheKey);
                    if (!resolvedAnnotations.has(cacheKey)) {
                        resolved = resolveAnnotation(annotation.name, parsed, enclosingScope, RESOLVABLE_NON_HTTP_ANNOTATIONS, incomplete);
                        resolvedAnnotations.set(cacheKey, resolved);
                    }
                    if (resolved !== undefined)
                        resolvedFactAnnotations.add(resolved);
                }
                const beanFactoryMethod = resolvedFactAnnotations.has(SPRING_BEAN_ANNOTATION);
                const kinds = new Set();
                for (const resolved of resolvedFactAnnotations) {
                    if (beanFactoryMethod && resolved === SPRING_SERVICE_ACTIVATOR_ANNOTATION)
                        continue;
                    const kind = HANDLER_ANNOTATIONS.get(resolved);
                    if (kind !== undefined)
                        kinds.add(kind);
                }
                if (kinds.size === 0)
                    continue;
                const owner = ownerGraphNode(fact, indexes, nodeLookup, graph, getExactOwnerByRange);
                if (owner === undefined || ownerClassLabel(owner.id) === 'Interface')
                    continue;
                const currentMultiplier = owner.properties.astFrameworkMultiplier ?? 1.0;
                owner.properties.astFrameworkMultiplier = Math.max(currentMultiplier, SPRING_NON_HTTP_HANDLER_ENTRY_POINT_MULTIPLIER);
                if (currentMultiplier < SPRING_NON_HTTP_HANDLER_ENTRY_POINT_MULTIPLIER ||
                    (currentMultiplier === SPRING_NON_HTTP_HANDLER_ENTRY_POINT_MULTIPLIER &&
                        owner.properties.astFrameworkReason === undefined)) {
                    owner.properties.astFrameworkReason = handlerReason(kinds);
                }
            }
        }
    };
}
