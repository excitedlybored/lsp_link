import type { AnalysisFeatureDescriptor } from '../../../analysis-features.js';
/** Durable completeness contract for Java/Kotlin Spring Bean evidence. */
export declare const SPRING_BEAN_INVENTORY_FEATURE: AnalysisFeatureDescriptor;
/** Durable completeness contract for conditional and auto-configuration evidence. */
export declare const SPRING_CONDITIONALS_FEATURE: AnalysisFeatureDescriptor;
/** Durable completeness contract for Spring proxy/advice evidence (#2416). */
export declare const SPRING_AOP_FEATURE: AnalysisFeatureDescriptor;
/** Durable completeness contract for scheduled, event, messaging, and job entry points (#2417). */
export declare const SPRING_NON_HTTP_HANDLERS_FEATURE: AnalysisFeatureDescriptor;
