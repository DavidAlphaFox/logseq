(ns ^:no-doc api
  (:require [frontend.db :as db]
            [frontend.db.model :as db-model]
            [frontend.handler.block :as block-handler]
            [frontend.util :as util]
            [electron.ipc :as ipc]
            [promesa.core :as p]
            [camel-snake-kebab.core :as csk]
            [cljs-bean.core :as bean]
            [frontend.state :as state]
            [frontend.components.plugins :as plugins]
            [frontend.handler.notification :as notification]
            [datascript.core :as d]
            [frontend.fs :as fs]
            [clojure.string :as string]
            [clojure.walk :as walk]
            [cljs.reader]
            [reitit.frontend.easy :as rfe]
            [frontend.db.query-dsl :as query-dsl]))

;; db
(defn ^:export q
  [query-string]
  (when-let [repo (state/get-current-repo)]
    (when-let [conn (db/get-conn repo)]
      (when-let [result (query-dsl/query repo query-string)]
        (clj->js @result)))))

(defn ^:export datascript_query
  [query & inputs]
  (when-let [repo (state/get-current-repo)]
    (when-let [conn (db/get-conn repo)]
      (let [query (cljs.reader/read-string query)
            result (apply d/q query conn inputs)]
        (clj->js result)))))

(def ^:export custom_query db/custom-query)

;; base
(def ^:export show_themes
  (fn []
    (plugins/open-select-theme!)))

(def ^:export set_theme_mode
  (fn [mode]
    (state/set-theme! (if (= mode "light") "white" "dark"))))

(def ^:export load_plugin_config
  (fn [path]
    (fs/read-file "" (util/node-path.join path "package.json"))))

(def ^:export load_plugin_readme
  (fn [path]
    (fs/read-file "" (util/node-path.join path "readme.md"))))

(def ^:export save_plugin_config
  (fn [path ^js data]
    (let [repo ""
          path (util/node-path.join path "package.json")]
      (fs/write-file! repo "" path (js/JSON.stringify data nil 2) {:skip-mtime? true}))))

(def ^:export write_user_tmp_file
  (fn [file content]
    (p/let [repo ""
            path (ipc/ipc "getLogseqUserRoot")
            path (util/node-path.join path "tmp")
            exist? (fs/file-exists? path "")
            _ (when-not exist? (fs/mkdir! path))
            path (util/node-path.join path file)
            _ (fs/write-file! repo "" path content {:skip-mtime? true})]
      path)))

(def ^:export load_user_preferences
  (fn []
    (p/let [repo ""
            path (ipc/ipc "getLogseqUserRoot")
            path (util/node-path.join path "preferences.json")
            _ (fs/create-if-not-exists repo "" path)
            json (fs/read-file "" path)
            json (if (string/blank? json) "{}" json)]
      (js/JSON.parse json))))

(def ^:export save_user_preferences
  (fn [^js data]
    (when data
      (p/let [repo ""
              path (ipc/ipc "getLogseqUserRoot")
              path (util/node-path.join path "preferences.json")]
        (fs/write-file! repo "" path (js/JSON.stringify data nil 2) {:skip-mtime? true})))))

(def ^:export load_plugin_user_settings
  (fn [key]
    (p/let [repo ""
            path (ipc/ipc "getLogseqUserRoot")
            exist? (fs/file-exists? path "settings")
            _ (when-not exist? (fs/mkdir! (util/node-path.join path "settings")))
            path (util/node-path.join path "settings" (str key ".json"))
            _ (fs/create-if-not-exists repo "" path "{}")
            json (fs/read-file "" path)]
      [path (js/JSON.parse json)])))

(def ^:export save_plugin_user_settings
  (fn [key ^js data]
    (p/let [repo ""
            path (ipc/ipc "getLogseqUserRoot")
            path (util/node-path.join path "settings" (str key ".json"))]
      (fs/write-file! repo "" path (js/JSON.stringify data nil 2) {:skip-mtime? true}))))

;; app
(def ^:export push_state
  (fn [^js k ^js params]
    (rfe/push-state
     (keyword k) (bean/->clj params))))

(def ^:export replace_state
  (fn [^js k ^js params]
    (rfe/replace-state
     (keyword k) (bean/->clj params))))

;; editor
(def ^:export get_current_page_blocks_tree
  (fn []
    (when-let [page (state/get-current-page)]
      (let [blocks (db-model/get-page-blocks-no-cache page)
            blocks (mapv #(-> %
                              (dissoc :block/children)
                              (assoc :block/uuid (str (:block/uuid %))))
                         blocks)
            blocks (block-handler/blocks->vec-tree blocks)
            ;; clean key
            blocks (walk/postwalk
                    (fn [a]
                      (if (keyword? a)
                        (csk/->camelCase (name a))
                        a)) blocks)]
        (bean/->js blocks)))))

;; helpers
(defn ^:export show_msg
  ([content] (show_msg content :success))
  ([content status] (notification/show! content (keyword status))))
