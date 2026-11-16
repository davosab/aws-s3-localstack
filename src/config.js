import { S3Client } from "@aws-sdk/client-s3";

// LocalStack accepts any credentials; "test"/"test" is the convention.
// The endpoint points the SDK at LocalStack instead of real AWS.
export const s3 = new S3Client({
  region: process.env.AWS_REGION ?? "us-east-1",
  endpoint: process.env.S3_ENDPOINT ?? "http://localhost:4566",
  forcePathStyle: true, // URLs like localhost:4566/<bucket>/<key> instead of <bucket>.localhost
  credentials: { accessKeyId: "test", secretAccessKey: "test" },
});

export const BUCKET = process.env.BUCKET ?? "docs-archive";
