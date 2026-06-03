import React, { useEffect, useMemo, useState } from "react";
import {
  AutoGrid,
  Box,
  Button,
  EmptyState,
  Flex,
  Heading,
  Icon,
  Input,
  LoadingSpinner,
  Modal,
  ModalBody,
  ModalFooter,
  Tab,
  Tabs,
  Tag,
  Text,
  TextArea,
  Tile,
  useExtensionApi,
} from "@hubspot/ui-extensions";
import { Canvas } from "../renderer/Canvas.jsx";
import { PageTitle } from "@hubspot/ui-extensions/pages";

import { useProjects } from "../state/projects.jsx";
import { Alert } from "@hubspot/ui-extensions";
import { BACKEND_ENABLED } from "../config.js";
import { useEffectRunner } from "../hooks/useEffectRunner.js";
import { createHomePageService } from "../lib/homePageServices.js";

// Tile descriptions: use Text.truncate for single-line display + hover
// tooltip with the full text. Multi-line wrapping is incompatible with
// Text.truncate (which forces single-line), so we accept shorter visible
// content in exchange for a working hover-reveal.
const descTooltip = (raw) => (raw ? raw.replace(/\s+/g, " ").trim() : "—");


// Preview modal for a full example spec. Renders the spec through the same
// Canvas the project page uses, so "Preview" shows exactly what "Use as
// template" would land you on — just without the project-creation step.
const ExamplePreviewModal = ({ example }) => {
  const [state, setState] = useState(example.spec?.state || {});
  const { actions } = useExtensionApi();
  const modalId = `example-preview-${example.name}`;

  const handleStateChange = (key, value) =>
    setState((prev) => ({ ...prev, [key]: value }));

  return (
    <Modal id={modalId} title={example.displayName} width="lg">
      <ModalBody>
        <Flex direction="column" gap="md">
          <Text>{example.description}</Text>
          <Tile compact={true}>
            <Canvas
              spec={example.spec}
              state={state}
              onStateChange={handleStateChange}
              actions={actions}
            />
          </Tile>
        </Flex>
      </ModalBody>
      <ModalFooter>
        <Button
          variant="secondary"
          onClick={() => actions.closeOverlay(modalId)}
        >
          Close
        </Button>
      </ModalFooter>
    </Modal>
  );
};

// Preview modal for a block. Renders the block's node through the same
// Canvas the project page uses, seeded with the block's dataShape so any
// $data.xyz references resolve. State is local — the block's $state.*
// references still work even though the Tweaks panel isn't wired here.
const BlockPreviewModal = ({ block }) => {
  const [state, setState] = useState(block.initialState || {});
  const { actions } = useExtensionApi();
  const modalId = `block-preview-${block.name}`;

  const handleStateChange = (key, value) =>
    setState((prev) => ({ ...prev, [key]: value }));

  // Worker must be on a build that inlines `node` into /knowledge/catalog.
  // If someone's running a stale worker, surface a specific error instead
  // of letting Canvas render its generic "No spec provided" fallback.
  const previewBody = !block.node ? (
    <Alert variant="warning" title="Preview unavailable">
      <Text>
        The worker didn't return this block's node content. Redeploy the worker
        (it now inlines blocks into <Text format={{ fontWeight: "demibold" }}>/knowledge/catalog</Text>)
        and try again.
      </Text>
    </Alert>
  ) : (
    <Tile compact={true}>
      <Canvas
        spec={{ state: {}, data: block.dataShape || {}, ...block.node }}
        state={state}
        onStateChange={handleStateChange}
        actions={actions}
      />
    </Tile>
  );

  return (
    <Modal id={modalId} title={block.name} width="lg">
      <ModalBody>
        <Flex direction="column" gap="md">
          <Text>{block.description}</Text>
          {block.componentsUsed?.length > 0 && (
            <Flex direction="row" gap="xs" wrap="wrap">
              {block.componentsUsed.map((c) => (
                <Tag key={c} variant="default">
                  {c}
                </Tag>
              ))}
            </Flex>
          )}
          {previewBody}
        </Flex>
      </ModalBody>
      <ModalFooter>
        <Button
          variant="secondary"
          onClick={() => actions.closeOverlay(modalId)}
        >
          Close
        </Button>
      </ModalFooter>
    </Modal>
  );
};

export const HomePage = () => {
  const { actions } = useExtensionApi();
  const { projects, createProject, loadError, isLoading, auth } = useProjects();
  const { mountedRef, runTracked, startDetached } = useEffectRunner();
  const homePageService = useMemo(
    () =>
      createHomePageService({
        auth,
        createProjectFn: createProject,
        mountedRef,
        navigateToPage: (projectId) => actions.navigateToPage({ to: `/projects/${projectId}` }),
        runTracked,
        startDetached,
      }),
    [actions, auth, createProject, mountedRef, runTracked, startDetached],
  );

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [rightTab, setRightTab] = useState("projects");

  // Knowledge catalog — blocks + example cards surfaced on the Examples
  // and Blocks tabs. Loaded once on mount; items are read-only so there's
  // no refresh concern.
  const [catalog, setCatalog] = useState(null);
  const [catalogError, setCatalogError] = useState(null);
  const [templatingName, setTemplatingName] = useState(null);

  useEffect(() => {
    if (!BACKEND_ENABLED) {
      setCatalog({ blocks: [], examples: [] });
      return;
    }
    return homePageService.startCatalogLoad({
      setCatalog,
      setCatalogError,
    });
  }, [homePageService]);

  const handleUseTemplate = async (example) => {
    if (templatingName) return;
    return homePageService.useTemplate({
      example,
      setTemplatingName,
    });
  };

  const projectsTitle =
    projects.length > 0 ? `Projects (${projects.length})` : "Projects";

  const canCreate = name.trim().length > 0;

  const [isCreating, setIsCreating] = useState(false);
  const handleCreate = async () => {
    if (!canCreate || isCreating) return;
    return homePageService.createProject({
      name,
      description,
      setIsCreating,
      resetDrafts: () => {
        setName("");
        setDescription("");
      },
    });
  };

  const handleOpen = (projectId) => {
    actions.navigateToPage({ to: `/projects/${projectId}` });
  };

  return (
    <Flex direction="column" gap="md">
      <Flex direction="column" gap="xs">
        <PageTitle>hs-uix Studio</PageTitle>
        <Flex direction="row" align="center" justify="between" gap="xs">
          <Flex direction="row" align="center" gap="xs">
            <Tag variant="default">Research preview</Tag>
            <Text variant="microcopy">
              Prompt, preview, and export HubSpot card prototypes — no code
              until you want it.
            </Text>
          </Flex>
          <Button
            variant="transparent"
            onClick={() => actions.navigateToPage({ to: "/settings" })}
          >
            <Icon name="settings" /> Settings & usage
          </Button>
        </Flex>
      </Flex>

      <Flex direction="row" gap="md" align="stretch">
        <Box flex={2} alignSelf="stretch">
          <Tile compact={true}>
            <Flex direction="column" gap="sm">
              <Heading>New project</Heading>
              <Text variant="microcopy">
                Describe a card and Studio will prototype it.
              </Text>
              <Input
                label="Project name"
                name="project-name"
                placeholder="e.g. Deal summary card"
                value={name}
                onInput={setName}
                required={true}
              />
              <TextArea
                label="What is it?"
                name="project-description"
                placeholder="Optional — a short description of the surface, audience, or goal."
                value={description}
                onInput={setDescription}
                rows={8}
              />
              <Button
                variant="primary"
                onClick={handleCreate}
                disabled={!canCreate || isCreating}
              >
                {isCreating ? "Creating..." : "Create"}
              </Button>
              <Text variant="microcopy">
                Only you can see your project by default.
              </Text>
            </Flex>
          </Tile>
        </Box>

        <Box flex={5} alignSelf="stretch">
          <Tile compact={true}>
            <Flex direction="column" gap="sm">
              <Tabs selected={rightTab} onSelectedChange={setRightTab}>
                <Tab
                  key={`projects-${projects.length}-${isLoading ? "l" : "r"}-${loadError ? "e" : "o"}`}
                  tabId="projects"
                  title={projectsTitle}
                  gap="sm"
                >
                  {loadError ? (
                    <Alert variant="error" title="Couldn't load projects">
                      <Text>
                        {loadError.status ? `${loadError.status} ` : ""}
                        {loadError.code || "error"}: {loadError.message || String(loadError)}
                      </Text>
                    </Alert>
                  ) : isLoading ? (
                    <Text variant="microcopy">Loading projects…</Text>
                  ) : projects.length === 0 ? (
                    <EmptyState
                      title="No projects yet"
                      layout="vertical"
                      imageName="components"
                      imageWidth={150}
                    >
                      <Text>
                        Create your first project on the left to start prototyping.
                      </Text>
                    </EmptyState>
                  ) : (
                    <AutoGrid columnWidth={220} gap="sm" flexible={true}>
                      {projects.map((p) => {
                        const desc = p.description || "—";
                        return (
                          <Tile key={p.id} compact={true}>
                            <Flex
                              direction="column"
                              gap="xs"
                              justify="between"
                              alignSelf="stretch"
                            >
                              <Flex direction="column" gap="xs">
                                <Icon name="developerProjects" size="md" />
                                <Text format={{ fontWeight: "demibold" }}>
                                  {p.name}
                                </Text>
                                <Text
                                  variant="microcopy"
                                  truncate={{ tooltipText: descTooltip(p.description) }}
                                >
                                  {descTooltip(p.description)}
                                </Text>
                                <Text variant="microcopy">
                                  Updated {p.updatedAt}
                                </Text>
                              </Flex>
                              <Button
                                variant="secondary"
                                onClick={() => handleOpen(p.id)}
                              >
                                Open
                              </Button>
                            </Flex>
                          </Tile>
                        );
                      })}
                    </AutoGrid>
                  )}
                </Tab>
                <Tab
                  key={`examples-${catalog?.examples?.length ?? 0}-${catalogError ? "e" : catalog ? "r" : "l"}`}
                  tabId="examples"
                  title={
                    catalog?.examples?.length
                      ? `Examples (${catalog.examples.length})`
                      : "Examples"
                  }
                  gap="sm"
                >
                  {catalogError ? (
                    <Alert variant="error" title="Couldn't load examples">
                      <Text>{catalogError.message || String(catalogError)}</Text>
                    </Alert>
                  ) : !catalog ? (
                    <Flex align="center" justify="center">
                      <LoadingSpinner size="sm" label="Loading examples…" showLabel={true} layout="centered" />
                    </Flex>
                  ) : catalog.examples.length === 0 ? (
                    <EmptyState
                      title="No examples yet"
                      layout="vertical"
                      imageName="components"
                      imageWidth={150}
                    >
                      <Text>Examples will appear here once the worker ships them.</Text>
                    </EmptyState>
                  ) : (
                    <AutoGrid columnWidth={260} gap="sm" flexible={true}>
                      {catalog.examples.map((ex) => (
                        <Tile key={ex.name} compact={true}>
                          <Flex
                            direction="column"
                            gap="sm"
                            justify="between"
                            alignSelf="stretch"
                          >
                            <Flex direction="column" gap="sm">
                              <Text format={{ fontWeight: "demibold" }}>
                                {ex.displayName}
                              </Text>
                              <Flex direction="row" gap="xs" wrap="wrap">
                                <Tag variant="default">{ex.surface || "—"}</Tag>
                                <Tag variant="default">{ex.object || "—"}</Tag>
                              </Flex>
                              <Text
                                truncate={{
                                  tooltipText: descTooltip(
                                    ex.tagline || ex.description,
                                  ),
                                }}
                              >
                                {descTooltip(ex.tagline || ex.description)}
                              </Text>
                            </Flex>
                            <Flex direction="row" gap="xs">
                              <Button
                                variant="secondary"
                                overlay={<ExamplePreviewModal example={ex} />}
                              >
                                Preview
                              </Button>
                              <Button
                                variant="primary"
                                disabled={templatingName === ex.name}
                                onClick={() => handleUseTemplate(ex)}
                              >
                                {templatingName === ex.name ? "Creating…" : "Use template"}
                              </Button>
                            </Flex>
                          </Flex>
                        </Tile>
                      ))}
                    </AutoGrid>
                  )}
                </Tab>
                <Tab
                  key={`blocks-${catalog?.blocks?.length ?? 0}-${catalogError ? "e" : catalog ? "r" : "l"}`}
                  tabId="blocks"
                  title={
                    catalog?.blocks?.length
                      ? `Blocks (${catalog.blocks.length})`
                      : "Blocks"
                  }
                  gap="sm"
                >
                  {catalogError ? (
                    <Alert variant="error" title="Couldn't load blocks">
                      <Text>{catalogError.message || String(catalogError)}</Text>
                    </Alert>
                  ) : !catalog ? (
                    <Flex align="center" justify="center">
                      <LoadingSpinner size="sm" label="Loading blocks…" showLabel={true} layout="centered" />
                    </Flex>
                  ) : catalog.blocks.length === 0 ? (
                    <EmptyState
                      title="No blocks yet"
                      layout="vertical"
                      imageName="components"
                      imageWidth={150}
                    >
                      <Text>Prebuilt component groups will appear here.</Text>
                    </EmptyState>
                  ) : (
                    <AutoGrid columnWidth={260} gap="sm" flexible={true}>
                      {catalog.blocks.map((b) => (
                        <Tile key={b.name} compact={true}>
                          <Flex
                            direction="column"
                            gap="sm"
                            justify="between"
                            alignSelf="stretch"
                          >
                            <Flex direction="column" gap="sm">
                              <Text format={{ fontWeight: "demibold" }}>{b.name}</Text>
                              <Text
                                truncate={{ tooltipText: descTooltip(b.description) }}
                              >
                                {descTooltip(b.description)}
                              </Text>
                              {b.componentsUsed?.length > 0 && (
                                <Flex direction="row" gap="xs" wrap="wrap">
                                  {b.componentsUsed.slice(0, 2).map((c) => (
                                    <Tag key={c} variant="default">
                                      {c}
                                    </Tag>
                                  ))}
                                  {b.componentsUsed.length > 2 && (
                                    <Tag variant="default">
                                      {`+${b.componentsUsed.length - 2}`}
                                    </Tag>
                                  )}
                                </Flex>
                              )}
                            </Flex>
                            <Button
                              variant="secondary"
                              overlay={<BlockPreviewModal block={b} />}
                            >
                              Preview
                            </Button>
                          </Flex>
                        </Tile>
                      ))}
                    </AutoGrid>
                  )}
                </Tab>
              </Tabs>
            </Flex>
          </Tile>
        </Box >
      </Flex >
    </Flex >
  );
};
