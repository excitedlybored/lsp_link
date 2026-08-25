package dev.gitnexus.bazelsample.merchantapi;

import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/work-items")
class WorkItemController {
  private final WorkItemService service;
  WorkItemController(WorkItemService service) { this.service = service; }
  @PostMapping ResponseEntity<WorkItemView> create(@RequestBody CreateWorkItemCommand command) {
    return ResponseEntity.accepted().body(service.create(command));
  }
  @GetMapping("/{id}") WorkItemView find(@PathVariable String id) { return service.find(id); }
}
