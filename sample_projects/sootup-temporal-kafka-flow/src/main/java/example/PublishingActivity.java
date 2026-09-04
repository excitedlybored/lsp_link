package example;
import io.temporal.activity.ActivityInterface;
@ActivityInterface
public interface PublishingActivity {
  void publish(String payload);
}
