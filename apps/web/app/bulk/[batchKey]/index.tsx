// `/bulk/[batchKey]` alone has nothing of its own to show — photos is where
// preparing a batch starts.
import { Redirect, useLocalSearchParams } from "expo-router";

export default function BulkBatchIndex() {
  const { batchKey } = useLocalSearchParams<{ batchKey: string }>();
  return <Redirect href={{ pathname: "/bulk/[batchKey]/photos", params: { batchKey } }} />;
}
