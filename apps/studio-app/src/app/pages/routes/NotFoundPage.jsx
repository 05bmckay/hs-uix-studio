import React from "react";
import { EmptyState, Flex, Text } from "@hubspot/ui-extensions";
import { PageLink, PageTitle } from "@hubspot/ui-extensions/pages";

export const NotFoundPage = () => {
  return (
    <Flex direction="column" gap="md">
      <PageTitle>Not found</PageTitle>
      <EmptyState title="Page not found" layout="vertical">
        <Text>The page you're looking for doesn't exist.</Text>
        <PageLink to="/">Back to Studio home</PageLink>
      </EmptyState>
    </Flex>
  );
};
