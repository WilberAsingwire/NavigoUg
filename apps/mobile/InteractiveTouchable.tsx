import { useRef } from "react";
import {
  Animated,
  TouchableOpacity,
  type TouchableOpacityProps
} from "react-native";

type InteractiveTouchableProps = TouchableOpacityProps & {
  /** Scale used while the control is pressed. Keep close to 1 for subtle feedback. */
  pressScale?: number;
};

const AnimatedTouchableOpacity = Animated.createAnimatedComponent(TouchableOpacity);

/**
 * Shared touch target for NAVIGO. Keeps native TouchableOpacity behaviour while
 * adding a restrained spring response and consistent accessibility defaults.
 */
export function InteractiveTouchable({
  pressScale = 0.985,
  activeOpacity = 0.88,
  disabled,
  onPressIn,
  onPressOut,
  style,
  ...props
}: InteractiveTouchableProps) {
  const scale = useRef(new Animated.Value(1)).current;

  function animateTo(value: number) {
    Animated.spring(scale, {
      toValue: value,
      useNativeDriver: true,
      speed: 32,
      bounciness: 3
    }).start();
  }

  return (
    <AnimatedTouchableOpacity
      {...props}
      disabled={disabled}
      activeOpacity={activeOpacity}
      accessibilityRole={props.accessibilityRole ?? "button"}
      onPressIn={(event) => {
        if (!disabled) animateTo(pressScale);
        onPressIn?.(event);
      }}
      onPressOut={(event) => {
        animateTo(1);
        onPressOut?.(event);
      }}
      style={[style, { transform: [{ scale }] }]}
    />
  );
}
