import React from "react";
import { hubspot } from "@hubspot/ui-extensions";
import { createPageRouter, PageRoutes } from "@hubspot/ui-extensions/pages";

import { HomePage } from "./routes/HomePage.jsx";
import { ProjectPage } from "./routes/ProjectPage.jsx";
import { SettingsPage } from "./routes/SettingsPage.jsx";
import { NotFoundPage } from "./routes/NotFoundPage.jsx";
import { ProjectsProvider } from "./state/projects.jsx";

const PageRouter = createPageRouter(
  <PageRoutes>
    <PageRoutes.IndexRoute id="home" component={HomePage} />
    <PageRoutes.Route
      id="project"
      path="/projects/:projectId"
      component={ProjectPage}
    />
    <PageRoutes.Route id="settings" path="/settings" component={SettingsPage} />
    <PageRoutes.AnyRoute id="not-found" component={NotFoundPage} />
  </PageRoutes>
);

hubspot.extend(() => (
  <ProjectsProvider>
    <PageRouter />
  </ProjectsProvider>
));
