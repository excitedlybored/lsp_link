package com.temporal.demos.temporalspringbootdemo.patterns.repository;

import org.springframework.stereotype.Repository;

import java.util.*;
import java.util.concurrent.ConcurrentHashMap;

@Repository
public class OrderRepository implements GenericRepository<Order, String> {
    private final Map<String, Order> store = new ConcurrentHashMap<>();

    @Override
    public Order save(Order entity) {
        store.put(entity.getOrderId(), entity);
        return entity;
    }

    @Override
    public List<Order> saveAll(Iterable<Order> entities) {
        List<Order> saved = new ArrayList<>();
        for (Order o : entities) {
            saved.add(save(o));
        }
        return saved;
    }

    @Override
    public Optional<Order> findById(String id) {
        return Optional.ofNullable(store.get(id));
    }

    @Override
    public void deleteById(String id) {
        store.remove(id);
    }
}
