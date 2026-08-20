package com.temporal.demos.temporalspringbootdemo.patterns.repository;

import java.util.List;
import java.util.Optional;

public interface GenericRepository<T, ID> {
    T save(T entity);
    List<T> saveAll(Iterable<T> entities);
    Optional<T> findById(ID id);
    void deleteById(ID id);
}
