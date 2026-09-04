package org.springframework.kafka.annotation;
import java.lang.annotation.*;
@Retention(RetentionPolicy.RUNTIME)
@Target(ElementType.METHOD)
public @interface KafkaListener {
  String[] topics() default {};
  String groupId() default "";
}
