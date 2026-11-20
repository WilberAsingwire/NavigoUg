import { forwardRef, type ComponentProps, type ComponentRef } from "react";
import { View } from "react-native";

type Region = {
  latitude: number;
  longitude: number;
  latitudeDelta: number;
  longitudeDelta: number;
};

type WebMapProps = ComponentProps<typeof View> & {
  region?: Region;
  initialRegion?: Region;
  onRegionChangeComplete?: (region: Region, details?: { isGesture: boolean }) => void;
  onMapReady?: () => void;
  scrollEnabled?: boolean;
  zoomEnabled?: boolean;
  rotateEnabled?: boolean;
  pitchEnabled?: boolean;
  toolbarEnabled?: boolean;
  showsCompass?: boolean;
  showsScale?: boolean;
  showsUserLocation?: boolean;
  showsMyLocationButton?: boolean;
  customMapStyle?: unknown;
};

const WebMapView = forwardRef<ComponentRef<typeof View>, WebMapProps>(function WebMapView(
  {
    region: _region,
    initialRegion: _initialRegion,
    onRegionChangeComplete: _onRegionChangeComplete,
    onMapReady: _onMapReady,
    scrollEnabled: _scrollEnabled,
    zoomEnabled: _zoomEnabled,
    rotateEnabled: _rotateEnabled,
    pitchEnabled: _pitchEnabled,
    toolbarEnabled: _toolbarEnabled,
    showsCompass: _showsCompass,
    showsScale: _showsScale,
    showsUserLocation: _showsUserLocation,
    showsMyLocationButton: _showsMyLocationButton,
    customMapStyle: _customMapStyle,
    ...viewProps
  },
  ref
) {
  return <View ref={ref} {...viewProps} />;
});

WebMapView.displayName = "WebMapView";

export default WebMapView;

// SafeMapView renders the shared OSM raster renderer on web, so these native
// overlay components are intentionally inert in the browser bundle.
export function Marker(): null {
  return null;
}

export function Polyline(): null {
  return null;
}
